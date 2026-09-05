import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AgentError, AgentSuccess } from '@/lib/ai/agent'
import type { QualifyOutput } from '@/lib/ai/schemas/qualify'
import { FACTOR_KEYS, NEUTRAL_SCORE } from '@/lib/scoring/rubric'
import { type QualifyRequest, type ScoreDeps, scoreLeadWith } from '@/lib/scoring/score'
import { type Result, err, ok } from '@/lib/types/result'

import { openDatabase } from './helpers'

/**
 * Lead qualification against real Postgres, with a scripted model.
 *
 * The model is faked and everything else is real. That split is deliberate: what
 * needs proving here is what gets *written* — the score, the factors, the audit row
 * and the status move, all in one transaction — and none of that is easier to see
 * through a real model that answers differently every time.
 *
 * Whether a score is any good is a separate question that no assertion can settle.
 * It is checked by reading the output of `pnpm score:leads` against real data.
 *
 * Its own workspace, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'qualify-test-workspace'

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string
let leadId: string
let contactedLeadId: string

// -----------------------------------------------------------------------------
// The scripted model
// -----------------------------------------------------------------------------

function output(scores: Partial<Record<(typeof FACTOR_KEYS)[number], number>>): QualifyOutput {
  const factors = Object.fromEntries(
    FACTOR_KEYS.map((key) => [
      key,
      { score: scores[key] ?? NEUTRAL_SCORE, evidence: `Bukti tersimpan untuk ${key}.` },
    ]),
  )
  // Shaped by hand rather than parsed, so a schema change surfaces as a type error.
  return {
    factors: {
      industry_fit: factors.industry_fit ?? { score: NEUTRAL_SCORE, evidence: 'x'.repeat(12) },
      product_need: factors.product_need ?? { score: NEUTRAL_SCORE, evidence: 'x'.repeat(12) },
      company_size: factors.company_size ?? { score: NEUTRAL_SCORE, evidence: 'x'.repeat(12) },
      decision_maker: factors.decision_maker ?? { score: NEUTRAL_SCORE, evidence: 'x'.repeat(12) },
      location: factors.location ?? { score: NEUTRAL_SCORE, evidence: 'x'.repeat(12) },
      digital_signals: factors.digital_signals ?? { score: NEUTRAL_SCORE, evidence: 'x'.repeat(12) },
    },
    reason: 'Cocok dengan profil pelanggan ideal produk ini. Layak dihubungi minggu ini.',
  }
}

function success(value: QualifyOutput): AgentSuccess<QualifyOutput> {
  return {
    value,
    model: 'gemini-3.7-flash',
    tokensIn: 1200,
    tokensOut: 300,
    costUsd: 0.002025,
    latencyMs: 8400,
    attempts: [],
  }
}

type Harness = { deps: ScoreDeps; requests: QualifyRequest[] }

function answering(
  result: Result<AgentSuccess<QualifyOutput>, AgentError>,
): Harness {
  const requests: QualifyRequest[] = []
  return {
    requests,
    deps: {
      qualify: (request) => {
        requests.push(request)
        return Promise.resolve(result)
      },
    },
  }
}

// -----------------------------------------------------------------------------

type ActivityRow = { type: string; actor: string; payload: unknown }

async function activitiesFor(id: string): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    select type, actor, payload from activities
    where lead_id = ${id} order by created_at, id`
}

type LeadRow = {
  score: number | null
  category: string | null
  score_factors: unknown
  score_reason: string | null
  status: string
}

async function leadRow(id: string): Promise<LeadRow> {
  const [row] = await sql<LeadRow[]>`
    select score, category, score_factors, score_reason, status from leads where id = ${id}`
  if (row === undefined) throw new Error('lead fixture disappeared')
  return row
}

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${`${SLUG}-other`})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Qualify Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Qualify Other', ${`${SLUG}-other`}) returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')
  workspaceId = ws.id
  otherWorkspaceId = other.id

  await sql`
    insert into products (workspace_id, name, description, value_prop, icp)
    values (${workspaceId}, 'Paket POS Kasir Pro', 'Sistem kasir multi-cabang',
            'Rekap penjualan seluruh cabang otomatis setiap malam',
            ${sql.json({ industries: ['Ritel'], cities: ['Surabaya'], size_bands: ['11-50'] })})`
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
    insert into contacts (workspace_id, company_id, name, position, department)
    values (${workspaceId}, ${company.id}, 'Budi Hartono', 'Pemilik', 'Manajemen')
    returning id`
  if (contact === undefined) throw new Error('contact fixture failed')

  const [lead] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status)
    values (${workspaceId}, ${company.id}, ${contact.id}, 'new') returning id`
  const [contacted] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status, score, category)
    values (${workspaceId}, ${company.id}, ${contact.id}, 'contacted', 61, 'warm') returning id`
  if (lead === undefined || contacted === undefined) throw new Error('lead fixture failed')

  leadId = lead.id
  contactedLeadId = contacted.id
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${`${SLUG}-other`})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('scoring a new lead', () => {
  it('computes the total in code and stores the whole breakdown', async () => {
    const { deps } = answering(
      ok(success(output({
        industry_fit: 92, product_need: 88, company_size: 80,
        decision_maker: 85, location: 90, digital_signals: 60,
      }))),
    )

    const result = await scoreLeadWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 23 + 22 + 12 + 12.75 + 9 + 6 = 84.75 → 85. The model never returned this.
    expect(result.value.score).toBe(85)
    expect(result.value.category).toBe('hot')

    const row = await leadRow(leadId)
    expect(row.score).toBe(85)
    expect(row.category).toBe('hot')
    expect(row.score_reason).toContain('profil pelanggan ideal')
    expect(Array.isArray(row.score_factors)).toBe(true)
  })

  it('stores factors that add up to the stored score', async () => {
    // The same invariant seed.test.ts asserts. Both origins satisfy it or the
    // column means two different things depending on who wrote it.
    const { deps } = answering(ok(success(output({ industry_fit: 90, location: 20 }))))
    await scoreLeadWith({ workspaceId, leadId }, deps)

    const row = await leadRow(leadId)
    const factors = row.score_factors
    if (!Array.isArray(factors)) throw new Error('score_factors is not an array')

    const total = factors.reduce((sum: number, factor: unknown) => {
      if (typeof factor !== 'object' || factor === null) return sum
      const score = Reflect.get(factor, 'score')
      const weight = Reflect.get(factor, 'weight')
      return typeof score === 'number' && typeof weight === 'number'
        ? sum + score * weight
        : sum
    }, 0)

    expect(Math.round(total / 100)).toBe(row.score)
    expect(factors).toHaveLength(6)
  })

  it('moves the lead to qualified and writes both audit rows', async () => {
    const { deps } = answering(ok(success(output({ industry_fit: 70 }))))
    const result = await scoreLeadWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.statusChangedTo).toBe('qualified')

    expect((await leadRow(leadId)).status).toBe('qualified')

    const activities = await activitiesFor(leadId)
    expect(activities.map((a) => a.type)).toEqual(['lead_scored', 'status_changed'])
    // rule 10: the actor is on the row, and this one was not a human.
    expect(activities.every((a) => a.actor === 'ai')).toBe(true)
  })

  it('passes the stored facts to the model', async () => {
    // Guards the failure mode that looks like success: a prompt missing the stored
    // fields produces a flat wall of neutral scores and no error anywhere.
    const { deps, requests } = answering(ok(success(output({}))))
    await scoreLeadWith({ workspaceId, leadId }, deps)

    const prompt = requests[0]?.prompt ?? ''
    expect(prompt).toContain('Toko Sinar Abadi')
    expect(prompt).toContain('Ritel')
    expect(prompt).toContain('Surabaya')
    expect(prompt).toContain('Pemilik')
    expect(prompt).toContain('Paket POS Kasir Pro')
    expect(prompt).toContain('Rekap penjualan seluruh cabang')

    // And the rule that keeps an ungrounded factor honest.
    expect(requests[0]?.system ?? '').toContain(String(NEUTRAL_SCORE))
  })

  it('lands an all-neutral lead at 50 warm', async () => {
    // What SPEC §4 forces when nothing is grounded. It must never read as a
    // recommendation.
    const { deps } = answering(ok(success(output({}))))
    const result = await scoreLeadWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.score).toBe(50)
    expect(result.value.category).toBe('warm')
  })
})

describe('what it refuses to do twice', () => {
  it('skips a lead that already has a score', async () => {
    const { deps, requests } = answering(ok(success(output({ industry_fit: 70 }))))
    await scoreLeadWith({ workspaceId, leadId }, deps)

    const second = answering(ok(success(output({ industry_fit: 10 }))))
    const result = await scoreLeadWith({ workspaceId, leadId }, second.deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('already_scored')
    // No second call means no second bill.
    expect(second.requests).toEqual([])
    expect(requests).toHaveLength(1)
  })

  it('re-scores when asked explicitly', async () => {
    const first = answering(ok(success(output({ industry_fit: 20, product_need: 20 }))))
    await scoreLeadWith({ workspaceId, leadId }, first.deps)
    const before = await leadRow(leadId)

    const second = answering(ok(success(output({ industry_fit: 95, product_need: 95 }))))
    const result = await scoreLeadWith({ workspaceId, leadId, rescore: true }, second.deps)

    expect(result.ok).toBe(true)
    const after = await leadRow(leadId)
    expect(after.score).toBeGreaterThan(before.score ?? 0)
  })
})

describe('a lead the pipeline has already moved past', () => {
  it('updates the score but leaves the status alone', async () => {
    // Re-scoring must never drag a contacted lead back to qualified.
    const { deps } = answering(ok(success(output({ industry_fit: 90 }))))
    const result = await scoreLeadWith(
      { workspaceId, leadId: contactedLeadId, rescore: true },
      deps,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.statusChangedTo).toBe(null)

    expect((await leadRow(contactedLeadId)).status).toBe('contacted')
    const activities = await activitiesFor(contactedLeadId)
    expect(activities.map((a) => a.type)).toEqual(['lead_scored'])
  })
})

describe('when the model fails', () => {
  it('leaves the lead exactly as it was', async () => {
    const { deps } = answering(
      err({ kind: 'rate_limited', message: 'quota exhausted', attempts: [] }),
    )

    const result = await scoreLeadWith({ workspaceId, leadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('model_failed')

    const row = await leadRow(leadId)
    expect(row.score).toBe(null)
    expect(row.status).toBe('new')
    expect(await activitiesFor(leadId)).toEqual([])
  })
})

describe('tenant isolation', () => {
  it('cannot score a lead belonging to another workspace', async () => {
    // rule 6. Drizzle bypasses RLS, so the workspace filter in the query is the
    // only thing standing here.
    const { deps, requests } = answering(ok(success(output({ industry_fit: 90 }))))
    const result = await scoreLeadWith({ workspaceId: otherWorkspaceId, leadId }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('lead_not_found')
    expect(requests).toEqual([])
    expect((await leadRow(leadId)).score).toBe(null)
  })
})
