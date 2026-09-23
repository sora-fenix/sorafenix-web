import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AgentError, AgentSuccess } from '@/lib/ai/agent'
import type { GenerateContentOutput } from '@/lib/ai/schemas/generate'
import {
  type DraftDeps,
  type GenerateRequest,
  generateDraftWith,
} from '@/lib/outreach/draft'
import { type Result, err, ok } from '@/lib/types/result'

import { openDatabase } from './helpers'

/**
 * The content generator against real Postgres, with a scripted model.
 *
 * The model is faked and everything else is real, for the same reason
 * `qualify.test.ts` does it: what needs proving is what gets *written* — one
 * message row, at the status the code decided rather than the one the model
 * implied, plus the audit row that keeps what the model said.
 *
 * The case this file exists for is "a model reporting no gaps while quoting a
 * price it invented". Whether the copy is any good is a separate question no
 * assertion can settle; that one is answered by reading `pnpm generate:content`.
 *
 * Its own workspace, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'generate-test-workspace'

const PRICELIST =
  'Paket Basic: Rp 299.000 per outlet per bulan. Paket Pro: Rp 599.000 per outlet ' +
  'per bulan, mencakup manajemen stok. Diskon tahunan 15 persen untuk pembayaran di muka.'

/** Archived, and therefore not allowed to ground anything. */
const OLD_PRICELIST = 'Harga lama 2024. Paket Basic: Rp 149.000 per outlet per bulan.'

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string
let leadId: string
let newLeadId: string
let noEmailLeadId: string
let contactedLeadId: string

// -----------------------------------------------------------------------------
// The scripted model
// -----------------------------------------------------------------------------

const CLEAN_BODY =
  'Halo Pak Budi,\n\nSaya lihat Toko Sinar Abadi sudah punya beberapa cabang di ' +
  'Surabaya. Rekap penjualan antar cabang biasanya masih dikerjakan manual.\n\n' +
  'Boleh saya kirim ringkasannya?\n\nGenerate Test'

function output(overrides: Partial<GenerateContentOutput> = {}): GenerateContentOutput {
  return {
    subject: 'Rekap penjualan cabang Toko Sinar Abadi',
    body: CLEAN_BODY,
    cta: 'Boleh saya kirim ringkasannya?',
    personalization_used: ['perusahaan: Toko Sinar Abadi', 'kota: Surabaya'],
    missing_info: [],
    confidence: 0.8,
    ...overrides,
  }
}

function success(value: GenerateContentOutput): AgentSuccess<GenerateContentOutput> {
  return {
    value,
    model: 'gemini-3.7-flash',
    tokensIn: 2400,
    tokensOut: 420,
    costUsd: 0.00337,
    latencyMs: 11200,
    attempts: [],
  }
}

type Harness = { deps: DraftDeps; requests: GenerateRequest[] }

function answering(
  result: Result<AgentSuccess<GenerateContentOutput>, AgentError>,
): Harness {
  const requests: GenerateRequest[] = []
  return {
    requests,
    deps: {
      generate: (request) => {
        requests.push(request)
        return Promise.resolve(result)
      },
    },
  }
}

// -----------------------------------------------------------------------------

type MessageRow = {
  id: string
  channel: string
  direction: string
  status: string
  subject: string | null
  body: string | null
  idempotency_key: string | null
  sent_at: Date | null
}

async function messagesFor(id: string): Promise<MessageRow[]> {
  return sql<MessageRow[]>`
    select id, channel, direction, status, subject, body, idempotency_key, sent_at
    from messages where lead_id = ${id} order by created_at, id`
}

type ActivityRow = { type: string; actor: string; channel: string | null; payload: unknown }

async function activitiesFor(id: string): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    select type, actor, channel, payload from activities
    where lead_id = ${id} order by created_at, id`
}

function payloadOf(row: ActivityRow | undefined): Record<string, unknown> {
  if (row === undefined) throw new Error('no activity row was written')
  const { payload } = row
  if (typeof payload !== 'object' || payload === null) throw new Error('payload is not an object')
  return { ...payload }
}

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${`${SLUG}-other`})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Generate Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Generate Other', ${`${SLUG}-other`}) returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')
  workspaceId = ws.id
  otherWorkspaceId = other.id

  await sql`
    insert into products (workspace_id, name, description, value_prop)
    values (${workspaceId}, 'Paket POS Kasir Pro', 'Sistem kasir multi-cabang',
            'Rekap penjualan seluruh cabang otomatis setiap malam')`

  await sql`
    insert into knowledge_docs (workspace_id, type, title, content, is_active)
    values (${workspaceId}, 'pricelist', 'Daftar Harga 2026', ${PRICELIST}, true),
           (${workspaceId}, 'pricelist', 'Daftar Harga 2024', ${OLD_PRICELIST}, false)`
})

beforeEach(async () => {
  await sql`delete from companies where workspace_id in (${workspaceId}, ${otherWorkspaceId})`

  const [company] = await sql<{ id: string }[]>`
    insert into companies (workspace_id, name, industry, city, size_band, employee_count, description)
    values (${workspaceId}, 'Toko Sinar Abadi', 'Ritel', 'Surabaya', '11-50', 32,
            'Toko ritel dengan tiga cabang di Surabaya.')
    returning id`
  if (company === undefined) throw new Error('company fixture failed')

  const [contact] = await sql<{ id: string }[]>`
    insert into contacts (workspace_id, company_id, name, position, department, email)
    values (${workspaceId}, ${company.id}, 'Budi Hartono', 'Pemilik', 'Manajemen',
            'budi@sinarabadi.co.id')
    returning id`
  const [mute] = await sql<{ id: string }[]>`
    insert into contacts (workspace_id, company_id, name, position)
    values (${workspaceId}, ${company.id}, 'Sari Dewi', 'Manajer Operasional')
    returning id`
  if (contact === undefined || mute === undefined) throw new Error('contact fixture failed')

  const [lead] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status, score, category, score_reason)
    values (${workspaceId}, ${company.id}, ${contact.id}, 'qualified', 84, 'hot',
            'Ritel multi-cabang di Surabaya, cocok dengan profil pelanggan ideal.')
    returning id`
  const [fresh] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status)
    values (${workspaceId}, ${company.id}, ${contact.id}, 'new') returning id`
  const [noEmail] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status)
    values (${workspaceId}, ${company.id}, ${mute.id}, 'qualified') returning id`
  const [contacted] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status)
    values (${workspaceId}, ${company.id}, ${contact.id}, 'qualified') returning id`
  if (lead === undefined || fresh === undefined || noEmail === undefined || contacted === undefined) {
    throw new Error('lead fixture failed')
  }

  leadId = lead.id
  newLeadId = fresh.id
  noEmailLeadId = noEmail.id
  contactedLeadId = contacted.id

  await sql`
    insert into messages (workspace_id, lead_id, channel, direction, status, subject)
    values (${workspaceId}, ${contactedLeadId}, 'email', 'out', 'sent', 'Halo dari kami')`
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${`${SLUG}-other`})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('drafting for a qualified lead', () => {
  it('writes one email draft at pending_approval when nothing is missing', async () => {
    const { deps } = answering(ok(success(output())))

    const result = await generateDraftWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('pending_approval')
    expect(result.value.missingInfo).toEqual([])

    const messages = await messagesFor(leadId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.channel).toBe('email')
    expect(messages[0]?.direction).toBe('out')
    expect(messages[0]?.status).toBe('pending_approval')
    expect(messages[0]?.subject).toBe('Rekap penjualan cabang Toko Sinar Abadi')
    expect(messages[0]?.body).toContain('Toko Sinar Abadi')
    expect(messages[0]?.idempotency_key).toBe(`draft:email:${leadId}:0`)
    // Nothing in this slice sends. The row must look untouched by a sender.
    expect(messages[0]?.sent_at).toBe(null)
  })

  it('writes one activities row keeping everything the model said', async () => {
    // rule 10. The status decision overrules the model; the audit row must still
    // show what the model claimed, or the decision cannot be reviewed later.
    const { deps } = answering(
      ok(
        success(
          output({
            personalization_used: ['kota: Surabaya'],
            cta: 'Boleh saya kirim ringkasannya?',
            confidence: 0.72,
          }),
        ),
      ),
    )

    await generateDraftWith({ workspaceId, leadId }, deps)

    const activities = await activitiesFor(leadId)
    expect(activities.map((a) => a.type)).toEqual(['message_drafted'])
    expect(activities[0]?.actor).toBe('ai')
    expect(activities[0]?.channel).toBe('email')

    const payload = payloadOf(activities[0])
    expect(payload.model).toBe('gemini-3.7-flash')
    expect(payload.confidence).toBe(0.72)
    expect(payload.cta).toBe('Boleh saya kirim ringkasannya?')
    expect(payload.personalization_used).toEqual(['kota: Surabaya'])
    expect(payload.missing_info).toEqual([])
  })

  it('passes the stored facts and the active knowledge docs to the model', async () => {
    // Guards the failure mode that looks like success: a prompt missing the
    // knowledge base produces a draft with nothing to ground it and no error.
    const { deps, requests } = answering(ok(success(output())))
    await generateDraftWith({ workspaceId, leadId }, deps)

    const prompt = requests[0]?.prompt ?? ''
    expect(prompt).toContain('Toko Sinar Abadi')
    expect(prompt).toContain('Surabaya')
    expect(prompt).toContain('Budi Hartono')
    expect(prompt).toContain('Paket POS Kasir Pro')
    expect(prompt).toContain('Rp 299.000')
    // The archived pricelist is not shown, so the model cannot quote a dead price.
    expect(prompt).not.toContain('Rp 149.000')

    expect(requests[0]?.system ?? '').toContain('missing_info')
  })
})

describe('when a fact is missing', () => {
  it('holds the draft at needs_input with the gap left visible in the body', async () => {
    const { deps } = answering(
      ok(
        success(
          output({
            body: `${CLEAN_BODY}\n\nPaket Pro mulai [harga paket] per outlet.`,
            missing_info: ['Harga paket untuk 3 outlet belum ada di materi resmi'],
          }),
        ),
      ),
    )

    const result = await generateDraftWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('needs_input')

    const messages = await messagesFor(leadId)
    expect(messages[0]?.status).toBe('needs_input')
    // The empty slot is stored, not repaired and not dropped. A human fills it.
    expect(messages[0]?.body).toContain('[harga paket]')

    const payload = payloadOf((await activitiesFor(leadId))[0])
    expect(payload.missing_info).toContain('Harga paket untuk 3 outlet belum ada di materi resmi')
  })
})

describe('when the model is confident and wrong', () => {
  it('forces needs_input on an invented price even though missing_info was empty', async () => {
    // The case this module exists for. The model reports no gaps and quotes a
    // price that appears nowhere in the active knowledge docs.
    const { deps } = answering(
      ok(
        success(
          output({
            body: `${CLEAN_BODY}\n\nPaket kami hanya Rp 1.500.000 per bulan.`,
            missing_info: [],
            confidence: 0.95,
          }),
        ),
      ),
    )

    const result = await generateDraftWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('needs_input')
    expect(result.value.ungrounded).toEqual([{ kind: 'currency', term: 'rp1.500.000' }])

    expect((await messagesFor(leadId))[0]?.status).toBe('needs_input')

    const payload = payloadOf((await activitiesFor(leadId))[0])
    // Both sides of the disagreement survive: what the model said, and what the
    // code decided about it.
    expect(payload.model_missing_info).toEqual([])
    expect(payload.ungrounded).toEqual([{ kind: 'currency', term: 'rp1.500.000' }])
  })

  it('accepts a price that is in an ACTIVE knowledge doc verbatim', async () => {
    const { deps } = answering(
      ok(success(output({ body: `${CLEAN_BODY}\n\nPaket Pro Rp 599.000 per outlet per bulan.` }))),
    )

    const result = await generateDraftWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('pending_approval')
  })

  it('refuses a price that only an archived doc supports', async () => {
    // is_active is the whole reason the column exists: a price we no longer
    // charge must not ground a draft.
    const { deps } = answering(
      ok(success(output({ body: `${CLEAN_BODY}\n\nPaket Basic Rp 149.000 per outlet.` }))),
    )

    const result = await generateDraftWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('needs_input')
  })
})

describe('which leads are eligible', () => {
  it('refuses a lead that is not qualified yet', async () => {
    const { deps, requests } = answering(ok(success(output())))
    const result = await generateDraftWith({ workspaceId, leadId: newLeadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('not_qualified')
    // Refused before the model, so a lead that is not ready costs nothing.
    expect(requests).toEqual([])
    expect(await messagesFor(newLeadId)).toEqual([])
  })

  it('refuses a lead whose contact has no email, and says so', async () => {
    const { deps, requests } = answering(ok(success(output())))
    const result = await generateDraftWith({ workspaceId, leadId: noEmailLeadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('no_contact_email')
    expect(requests).toEqual([])
  })

  it('refuses a lead that already has an outbound message', async () => {
    const { deps, requests } = answering(ok(success(output())))
    const result = await generateDraftWith({ workspaceId, leadId: contactedLeadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('already_drafted')
    expect(requests).toEqual([])
    expect(await messagesFor(contactedLeadId)).toHaveLength(1)
  })

  it('returns a typed rejection when the idempotency key is taken', async () => {
    // The realistic collision: two drafts exist, someone deletes the first, and
    // the attempt counter lands back on a key that is still in use. The unique
    // index refuses it — the point of this test is that the refusal comes back as
    // a Result (rule 9) rather than throwing out of the sweep and killing every
    // remaining lead.
    await sql`
      update messages set idempotency_key = ${`draft:email:${contactedLeadId}:0`}
      where lead_id = ${contactedLeadId}`
    await sql`
      insert into messages (workspace_id, lead_id, channel, direction, status, idempotency_key)
      values (${workspaceId}, ${contactedLeadId}, 'email', 'out', 'draft',
              ${`draft:email:${contactedLeadId}:1`})`
    await sql`
      delete from messages
      where lead_id = ${contactedLeadId} and idempotency_key = ${`draft:email:${contactedLeadId}:0`}`

    // One outbound message left, so the next attempt number is 1 — already taken.
    const { deps } = answering(ok(success(output())))
    const result = await generateDraftWith(
      { workspaceId, leadId: contactedLeadId, regenerate: true },
      deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('duplicate_draft')

    // Idempotency held: no second row, and no orphan audit row either.
    expect(await messagesFor(contactedLeadId)).toHaveLength(1)
    expect(await activitiesFor(contactedLeadId)).toEqual([])
  })

  it('drafts again when asked explicitly, under its own idempotency key', async () => {
    const { deps } = answering(ok(success(output())))
    const result = await generateDraftWith(
      { workspaceId, leadId: contactedLeadId, regenerate: true },
      deps,
    )

    expect(result.ok).toBe(true)
    const messages = await messagesFor(contactedLeadId)
    expect(messages).toHaveLength(2)
    expect(messages[1]?.idempotency_key).toBe(`draft:email:${contactedLeadId}:1`)
  })
})

describe('when the model fails', () => {
  it('leaves the lead exactly as it was', async () => {
    const { deps } = answering(
      err({ kind: 'rate_limited', message: 'quota exhausted', attempts: [] }),
    )

    const result = await generateDraftWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('model_failed')

    expect(await messagesFor(leadId)).toEqual([])
    expect(await activitiesFor(leadId)).toEqual([])
  })
})

describe('tenant isolation', () => {
  it('cannot draft for a lead belonging to another workspace', async () => {
    // rule 6. Drizzle bypasses RLS, so the workspace filter in the query is the
    // only thing standing here.
    const { deps, requests } = answering(ok(success(output())))
    const result = await generateDraftWith({ workspaceId: otherWorkspaceId, leadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('lead_not_found')
    expect(requests).toEqual([])
    expect(await messagesFor(leadId)).toEqual([])
  })
})
