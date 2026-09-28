import { createHmac } from 'node:crypto'

import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from '@/app/api/webhooks/whatsapp/route'
import { type SendDeps, sendMessageWith } from '@/lib/outreach/send'
import type {
  WhatsAppSendError,
  WhatsAppSendRequest,
  WhatsAppSendResult,
  WhatsAppTransport,
} from '@/lib/outreach/whatsapp'
import { type Result, err, ok } from '@/lib/types/result'

import { openDatabase } from './helpers'

/**
 * The WhatsApp transport against real Postgres: the inbound route end to end, and
 * `sendMessage` with the provider faked.
 *
 * The transport is injected, the way `generate.test.ts` scripts the model, because
 * what needs proving is what gets WRITTEN — which workspace an inbound event lands
 * in, what an ack may and may not overwrite, and that a rejected send never reaches a
 * provider at all. Whether a real WAHA accepts our request body is a separate
 * question no assertion here can settle.
 *
 * Two workspaces throughout, with the SAME contact number in both. That is the case
 * this file exists for: the session name decides the tenant, and a phone number never
 * does.
 *
 * Its own workspaces, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG_A = 'waha-test-a'
const SLUG_B = 'waha-test-b'
const SESSION_A = 'waha-test-session-a'
const SESSION_B = 'waha-test-session-b'

/** The one number both workspaces know. */
const WA = '+6281234567890'
const CHAT_ID = '6281234567890@c.us'

/** Monday 2026-09-14, 10:00 WIB — inside business hours in every Indonesian zone. */
const MON_10_WIB = new Date('2026-09-14T03:00:00Z')

let sql: postgres.Sql
let workspaceA: string
let workspaceB: string
let campaignA: string

// -----------------------------------------------------------------------------
// The route
// -----------------------------------------------------------------------------

function secret(): string {
  const value = process.env.WAHA_WEBHOOK_HMAC_SECRET
  if (value === undefined || value === '') {
    throw new Error('WAHA_WEBHOOK_HMAC_SECRET is not set; see vitest.integration.config.ts')
  }
  return value
}

function sign(body: string, algorithm: 'sha256' | 'sha512' = 'sha512'): string {
  return createHmac(algorithm, secret()).update(body, 'utf8').digest('hex')
}

type Event = {
  event: string
  session: string
  payload: Record<string, unknown>
}

function messageEvent(overrides: Partial<Event> = {}): Event {
  return {
    event: 'message',
    session: SESSION_A,
    payload: {
      id: 'false_6281234567890@c.us_AAA111',
      timestamp: 1_767_225_600,
      from: CHAT_ID,
      body: 'Halo, boleh minta info harga?',
      hasMedia: false,
      ack: 1,
    },
    ...overrides,
  }
}

type PostOptions = {
  signature?: string | null
  algorithm?: string | null
}

async function post(body: unknown, options: PostOptions = {}): Promise<Response> {
  const raw = JSON.stringify(body)
  const headers = new Headers({ 'content-type': 'application/json' })

  const signature = options.signature === undefined ? sign(raw) : options.signature
  if (signature !== null) headers.set('x-webhook-hmac', signature)

  const algorithm = options.algorithm === undefined ? 'sha512' : options.algorithm
  if (algorithm !== null) headers.set('x-webhook-hmac-algorithm', algorithm)

  return POST(
    new Request('http://localhost:3000/api/webhooks/whatsapp', {
      method: 'POST',
      headers,
      body: raw,
    }),
  )
}

/** The response body as a bag of unknowns, narrowed at each assertion. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const json: unknown = await response.json()
  if (typeof json !== 'object' || json === null) throw new Error('response is not an object')
  return { ...json }
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

type Lead = { leadId: string; contactId: string }

async function makeLead(options: {
  workspace: string
  whatsapp?: string | null
  email?: string | null
}): Promise<Lead> {
  const ws = options.workspace
  const [company] = await sql<{ id: string }[]>`
    insert into companies (workspace_id, name, city, country)
    values (${ws}, 'Petshop Bintang', 'Surabaya', 'ID') returning id`
  if (company === undefined) throw new Error('company fixture failed')

  const whatsapp = options.whatsapp === undefined ? WA : options.whatsapp
  const [contact] = await sql<{ id: string }[]>`
    insert into contacts (workspace_id, company_id, name, whatsapp, phone, email)
    values (${ws}, ${company.id}, 'Budi', ${whatsapp}, ${whatsapp},
            ${options.email ?? null}) returning id`
  if (contact === undefined) throw new Error('contact fixture failed')

  const [lead] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, campaign_id, status)
    values (${ws}, ${company.id}, ${contact.id},
            ${ws === workspaceA ? campaignA : null}, 'qualified') returning id`
  if (lead === undefined) throw new Error('lead fixture failed')

  return { leadId: lead.id, contactId: contact.id }
}

async function makeOutbound(options: {
  workspace: string
  leadId: string
  status?: string
  providerMessageId?: string | null
  body?: string
  /** What `send.ts` writes on a successful send: the chat this went out on. */
  threadId?: string | null
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into messages (workspace_id, lead_id, channel, direction, status, body,
                          template_id, provider_message_id, thread_id)
    values (${options.workspace}, ${options.leadId}, 'whatsapp', 'out',
            ${options.status ?? 'approved'},
            ${options.body ?? 'Halo Pak Budi, boleh saya kirim ringkasannya?'},
            'sapaan_pertama', ${options.providerMessageId ?? null},
            ${options.threadId ?? null})
    returning id`
  if (row === undefined) throw new Error('message fixture failed')
  return row.id
}

async function webhookEventCount(...workspaceIds: string[]): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from webhook_events where workspace_id in ${sql(workspaceIds)}`
  return rows[0]?.n ?? -1
}

type Row = Record<string, unknown>

async function messagesIn(workspaceId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, lead_id, direction, status, body, provider_message_id, thread_id, sent_at
    from messages where workspace_id = ${workspaceId} order by created_at`
}

async function countOf(table: 'suppressions' | 'activities', workspaceId: string): Promise<number> {
  const rows =
    table === 'suppressions'
      ? await sql<{ n: number }[]>`
          select count(*)::int as n from suppressions where workspace_id = ${workspaceId}`
      : await sql<{ n: number }[]>`
          select count(*)::int as n from activities where workspace_id = ${workspaceId}`
  return rows[0]?.n ?? -1
}

// -----------------------------------------------------------------------------

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG_A}, ${SLUG_B})`

  const [a] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('WAHA Test A', ${SLUG_A}) returning id`
  const [b] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('WAHA Test B', ${SLUG_B}) returning id`
  if (a === undefined || b === undefined) throw new Error('workspace fixture failed')
  workspaceA = a.id
  workspaceB = b.id

  // What `pnpm wa:connect` writes.
  await sql`insert into integrations (workspace_id, provider, status, meta)
            values (${workspaceA}, 'whatsapp', 'connected', ${sql.json({ session: SESSION_A })})`
  await sql`insert into integrations (workspace_id, provider, status, meta)
            values (${workspaceB}, 'whatsapp', 'connected', ${sql.json({ session: SESSION_B })})`
})

beforeEach(async () => {
  await sql`delete from companies where workspace_id in (${workspaceA}, ${workspaceB})`
  await sql`delete from messages where workspace_id in (${workspaceA}, ${workspaceB})`
  await sql`delete from activities where workspace_id in (${workspaceA}, ${workspaceB})`
  await sql`delete from suppressions where workspace_id in (${workspaceA}, ${workspaceB})`
  await sql`delete from webhook_events where workspace_id in (${workspaceA}, ${workspaceB})`
  await sql`delete from campaigns where workspace_id in (${workspaceA}, ${workspaceB})`

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (workspace_id, name) values (${workspaceA}, 'Sapaan Petshop')
    returning id`
  if (campaign === undefined) throw new Error('campaign fixture failed')
  campaignA = campaign.id
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG_A}, ${SLUG_B})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------
// The signature comes first
// -----------------------------------------------------------------------------

describe('the inbound webhook, before it trusts anything', () => {
  it('refuses a request with no signature, and writes nothing', async () => {
    const response = await post(messageEvent(), { signature: null })

    expect(response.status).toBe(401)
    expect(await bodyOf(response)).toEqual({ error: 'invalid_signature' })
    expect(await messagesIn(workspaceA)).toHaveLength(0)
  })

  it('refuses a body that changed after it was signed', async () => {
    const signed = sign(JSON.stringify(messageEvent()))
    const tampered = messageEvent({ session: SESSION_B })

    const response = await post(tampered, { signature: signed })
    expect(response.status).toBe(401)
    expect(await messagesIn(workspaceB)).toHaveLength(0)
  })

  it('refuses a sha256 digest when the header names sha512', async () => {
    const raw = JSON.stringify(messageEvent())
    const response = await post(messageEvent(), { signature: sign(raw, 'sha256') })
    expect(response.status).toBe(401)
  })

  it('accepts a sha256 digest when the header says so', async () => {
    const raw = JSON.stringify(messageEvent())
    const response = await post(messageEvent(), {
      signature: sign(raw, 'sha256'),
      algorithm: 'sha256',
    })
    expect(response.status).toBe(200)
  })

  it('refuses an algorithm it does not know rather than guessing', async () => {
    const raw = JSON.stringify(messageEvent())
    const response = await post(messageEvent(), { signature: sign(raw), algorithm: 'md5' })
    expect(response.status).toBe(401)
  })

  it('rejects a payload that is signed but malformed', async () => {
    const response = await post({ event: 'message', session: SESSION_A })
    expect(response.status).toBe(422)
    expect(await bodyOf(response)).toMatchObject({ error: 'invalid_payload' })
  })
})

// -----------------------------------------------------------------------------
// Which workspace an event belongs to
// -----------------------------------------------------------------------------

describe('attribution', () => {
  it('files a reply against the lead in the workspace that owns the session', async () => {
    const inA = await makeLead({ workspace: workspaceA })
    const inB = await makeLead({ workspace: workspaceB })

    const response = await post(messageEvent())
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toMatchObject({ kind: 'stored', leadId: inA.leadId })

    const stored = await messagesIn(workspaceA)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      lead_id: inA.leadId,
      direction: 'in',
      status: 'delivered',
      body: 'Halo, boleh minta info harga?',
      provider_message_id: 'false_6281234567890@c.us_AAA111',
      thread_id: CHAT_ID,
    })

    // The same number is a contact in B as well. B hears nothing about it.
    expect(await messagesIn(workspaceB)).toHaveLength(0)
    expect(inB.leadId).not.toBe(inA.leadId)
  })

  it('reads WAHA’s seconds as seconds, not milliseconds', async () => {
    await makeLead({ workspace: workspaceA })
    await post(messageEvent())

    const [stored] = await messagesIn(workspaceA)
    const sentAt = stored?.sent_at
    if (!(sentAt instanceof Date)) throw new Error('sent_at was not a timestamp')
    expect(sentAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('acknowledges a session no workspace owns, and writes nothing anywhere', async () => {
    await makeLead({ workspace: workspaceA })
    // Silently dropping every reply is the expensive failure here — a typo in
    // `wa:connect --session` would look exactly like a quiet customer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await post(messageEvent({ session: 'a-session-nobody-registered' }))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('a-session-nobody-registered')
    warn.mockRestore()

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      kind: 'unattributable',
      reason: 'unknown_session',
    })
    expect(await messagesIn(workspaceA)).toHaveLength(0)
    expect(await messagesIn(workspaceB)).toHaveLength(0)

    // Not even a receipt: a webhook_events row needs a workspace we do not have.
    const events = await sql<{ n: number }[]>`select count(*)::int as n from webhook_events
      where workspace_id in (${workspaceA}, ${workspaceB})`
    expect(events[0]?.n).toBe(0)
  })

  // Migration 0018. This is what makes `ambiguous_session` unreachable, so the index
  // is asserted here rather than the branch it protects.
  it('cannot have two workspaces registered to one session', async () => {
    let message = ''
    try {
      await sql`update integrations set meta = ${sql.json({ session: SESSION_A })}
                where workspace_id = ${workspaceB} and provider = 'whatsapp'`
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('integrations_whatsapp_session_key')

    // And B still owns its own session, so the rest of the file is unaffected.
    const rows = await sql<{ session: string }[]>`
      select meta->>'session' as session from integrations
      where workspace_id = ${workspaceB} and provider = 'whatsapp'`
    expect(rows[0]?.session).toBe(SESSION_B)
  })

  it('stores a group message from nobody it knows nowhere at all', async () => {
    await makeLead({ workspace: workspaceA })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await post(
      messageEvent({
        payload: { ...messageEvent().payload, from: '6281234567890-1600000000@g.us' },
      }),
    )

    // A group is not a contact, and its other members never agreed to anything.
    expect(await bodyOf(response)).toEqual({ kind: 'ignored_unmatched_chat' })
    expect(await messagesIn(workspaceA)).toHaveLength(0)
    warn.mockRestore()
  })

  /**
   * WAHA documents `message` as incoming-only, so this is insurance. If any engine ever
   * echoes our own outbound text on `message`, storing it as `direction: 'in'` against
   * the lead would feed our own opener to reply classification as the customer's answer.
   */
  it('ignores an echo of our own outbound message', async () => {
    await makeLead({ workspace: workspaceA })

    const flagged = await post(
      messageEvent({ payload: { ...messageEvent().payload, fromMe: true } }),
    )
    expect(await bodyOf(flagged)).toEqual({ kind: 'ignored_echo' })

    const byId = await post(
      messageEvent({
        payload: { ...messageEvent().payload, id: 'true_6281234567890@c.us_MINE' },
      }),
    )
    expect(await bodyOf(byId)).toEqual({ kind: 'ignored_echo' })

    expect(await messagesIn(workspaceA)).toHaveLength(0)
    const events = await sql<{ n: number }[]>`select count(*)::int as n from webhook_events
      where workspace_id = ${workspaceA}`
    expect(events[0]?.n).toBe(0)
  })

  it('ignores an event it does not handle, and writes nothing', async () => {
    await makeLead({ workspace: workspaceA })

    const response = await post(messageEvent({ event: 'session.status' }))

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ kind: 'ignored_event', event: 'session.status' })
    expect(await messagesIn(workspaceA)).toHaveLength(0)
  })

  it('stores one row when WAHA delivers the same event twice', async () => {
    await makeLead({ workspace: workspaceA })

    const first = await post(messageEvent())
    const second = await post(messageEvent())

    expect(await bodyOf(first)).toMatchObject({ kind: 'stored' })
    expect(await bodyOf(second)).toEqual({ kind: 'replayed' })
    expect(await messagesIn(workspaceA)).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
// Whose conversation is this
// -----------------------------------------------------------------------------

/**
 * Owner decision, 2026-09-28. The client's own WhatsApp account is connected, so WAHA
 * delivers their private chats too — six of them reached `messages` during a test with
 * a personal number on 2026-09-27. An inbound message is kept only when this workspace
 * is already a party to the chat, and everything else is a 200 with nothing written.
 *
 * `webhook_events` is asserted as hard as `messages` here: its `payload` column is the
 * whole webhook body, so a receipt for a dropped message would store the very text the
 * drop was for.
 */
describe('an inbound message on a chat that is not ours', () => {
  /** WhatsApp's opaque linked-id, exactly as live traffic delivered it on 2026-09-27. */
  const LID = '30589042323502@lid'

  const stranger = messageEvent({
    payload: {
      id: 'false_30589042323502@lid_PRIV1',
      timestamp: 1_767_225_700,
      from: LID,
      body: 'Ma, nanti sore jadi jemput adik?',
    },
  })

  it('writes no message row and no webhook_events receipt', async () => {
    await makeLead({ workspace: workspaceA })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await post(stranger)

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ kind: 'ignored_unmatched_chat' })
    expect(await messagesIn(workspaceA)).toHaveLength(0)
    expect(await messagesIn(workspaceB)).toHaveLength(0)
    expect(await webhookEventCount(workspaceA, workspaceB)).toBe(0)
    warn.mockRestore()
  })

  it('warns with the chat id, and never with what was said', async () => {
    await makeLead({ workspace: workspaceA })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await post(stranger)

    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]?.[0]
    warn.mockRestore()

    // The diagnostic that would tell us the correlation key is wrong: `@lid` can match
    // no `@c.us` thread, and no regex can recover a number that is not in the id.
    expect(line).toContain(LID)
    expect(line).toContain(SESSION_A)
    // And the leak this whole rule exists to prevent, in a log file instead of a table.
    expect(line).not.toContain('jemput adik')
  })

  it('does not treat a chat another workspace started as ours', async () => {
    // B sent to this number; A did not, and A has no contact for it.
    const inB = await makeLead({ workspace: workspaceB })
    await makeOutbound({
      workspace: workspaceB,
      leadId: inB.leadId,
      status: 'sent',
      threadId: CHAT_ID,
    })
    await makeLead({ workspace: workspaceA, whatsapp: '+628999000111' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await post(messageEvent())

    expect(await bodyOf(response)).toEqual({ kind: 'ignored_unmatched_chat' })
    expect(await messagesIn(workspaceA)).toHaveLength(0)
    expect(await webhookEventCount(workspaceA)).toBe(0)
    warn.mockRestore()
  })
})

describe('an inbound message on a chat we started', () => {
  it('is stored even when the number matches no contact', async () => {
    // What a reply to a campaign send looks like once the contact row has been edited
    // or the lead moved: the thread is the evidence, not the phone book.
    const { leadId } = await makeLead({ workspace: workspaceA, whatsapp: '+628999000111' })
    await makeOutbound({
      workspace: workspaceA,
      leadId,
      status: 'sent',
      threadId: CHAT_ID,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await post(messageEvent())

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()

    // Attributed to the lead of the message it answers.
    expect(await bodyOf(response)).toMatchObject({ kind: 'stored', leadId })
    const stored = await messagesIn(workspaceA)
    expect(stored).toHaveLength(2)
    expect(stored[1]).toMatchObject({
      lead_id: leadId,
      direction: 'in',
      status: 'delivered',
      thread_id: CHAT_ID,
    })
    expect(await webhookEventCount(workspaceA)).toBe(1)
  })

  /**
   * An inbound row carries the same `thread_id`, so matching on any message on the
   * thread would make the first stored foreign message the reason the second one is
   * stored too. Only our own outbound counts.
   */
  it('is not made ours by an earlier inbound row on the same thread', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA, whatsapp: '+628999000111' })
    await sql`insert into messages (workspace_id, lead_id, channel, direction, status,
                                    body, thread_id)
              values (${workspaceA}, ${leadId}, 'whatsapp', 'in', 'delivered',
                      'pesan lama', ${CHAT_ID})`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await post(messageEvent())

    expect(await bodyOf(response)).toEqual({ kind: 'ignored_unmatched_chat' })
    expect(await messagesIn(workspaceA)).toHaveLength(1)
    warn.mockRestore()
  })
})

// -----------------------------------------------------------------------------
// What the inbound path is not allowed to do
// -----------------------------------------------------------------------------

describe('an inbound "STOP"', () => {
  const stop = messageEvent({
    payload: {
      id: 'false_6281234567890@c.us_STOP',
      timestamp: 1_767_222_100,
      from: CHAT_ID,
      body: 'STOP. Jangan hubungi saya lagi.',
    },
  })

  it('is stored, and writes no suppression', async () => {
    await makeLead({ workspace: workspaceA })

    const response = await post(stop)

    expect(await bodyOf(response)).toMatchObject({ kind: 'stored' })
    // Suppressing on inbound text would mean one forged webhook could silence a
    // client's whole list. The classification slice does it, behind its own audit row.
    expect(await countOf('suppressions', workspaceA)).toBe(0)
    expect(await countOf('suppressions', workspaceB)).toBe(0)
  })

  it('does not move the lead, and writes no activity row', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })

    await post(stop)

    const leads = await sql<{ status: string }[]>`
      select status from leads where workspace_id = ${workspaceA} and id = ${leadId}`
    expect(leads[0]?.status).toBe('qualified')
    expect(await countOf('activities', workspaceA)).toBe(0)
  })

  it('creates no outbound message — nothing here auto-replies', async () => {
    await makeLead({ workspace: workspaceA })

    await post(stop)

    const outbound = (await messagesIn(workspaceA)).filter((row) => row.direction === 'out')
    expect(outbound).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Delivery acks
// -----------------------------------------------------------------------------

describe('a delivery ack', () => {
  const PROVIDER_ID = 'true_6281234567890@c.us_SENT1'

  function ack(code: number, overrides: Partial<Event> = {}): Event {
    return messageEvent({
      event: 'message.ack',
      payload: { id: PROVIDER_ID, timestamp: 1_767_222_200, from: CHAT_ID, ack: code },
      ...overrides,
    })
  }

  it('moves the matching outbound message forward', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    await makeOutbound({
      workspace: workspaceA,
      leadId,
      status: 'sent',
      providerMessageId: PROVIDER_ID,
    })

    const response = await post(ack(3))

    expect(await bodyOf(response)).toEqual({ kind: 'ack_applied', status: 'opened', updated: 1 })
    const [row] = await messagesIn(workspaceA)
    expect(row?.status).toBe('opened')
  })

  it('never moves a message backwards', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    await makeOutbound({
      workspace: workspaceA,
      leadId,
      status: 'replied',
      providerMessageId: PROVIDER_ID,
    })

    const response = await post(ack(2))

    expect(await bodyOf(response)).toMatchObject({ kind: 'ack_applied', updated: 0 })
    const [row] = await messagesIn(workspaceA)
    expect(row?.status).toBe('replied')
  })

  it('ignores a PENDING ack', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    await makeOutbound({
      workspace: workspaceA,
      leadId,
      status: 'sent',
      providerMessageId: PROVIDER_ID,
    })

    expect(await bodyOf(await post(ack(0)))).toEqual({ kind: 'ack_ignored', ack: 0 })
    const [row] = await messagesIn(workspaceA)
    expect(row?.status).toBe('sent')
  })

  it('does not touch another workspace’s message with the same provider id', async () => {
    const inA = await makeLead({ workspace: workspaceA })
    const inB = await makeLead({ workspace: workspaceB })
    await makeOutbound({
      workspace: workspaceA,
      leadId: inA.leadId,
      status: 'sent',
      providerMessageId: PROVIDER_ID,
    })
    await makeOutbound({
      workspace: workspaceB,
      leadId: inB.leadId,
      status: 'sent',
      providerMessageId: PROVIDER_ID,
    })

    await post(ack(3))

    expect((await messagesIn(workspaceA))[0]?.status).toBe('opened')
    expect((await messagesIn(workspaceB))[0]?.status).toBe('sent')
  })

  it('accepts an ack for a message it never recorded', async () => {
    const response = await post(ack(2))
    expect(await bodyOf(response)).toEqual({ kind: 'ack_applied', status: 'delivered', updated: 0 })
  })
})

// -----------------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------------

type Harness = { deps: SendDeps; sent: WhatsAppSendRequest[] }

function transport(answer: Result<WhatsAppSendResult, WhatsAppSendError>): Harness {
  const sent: WhatsAppSendRequest[] = []
  const fake: WhatsAppTransport = {
    provider: 'waha',
    send: async (request) => {
      sent.push(request)
      return answer
    },
  }
  return { sent, deps: { transport: fake } }
}

const ACCEPTED = ok<WhatsAppSendResult>({
  providerMessageId: 'true_6281234567890@c.us_OUT1',
  unparsedResponse: null,
})

describe('sendMessage', () => {
  // The guard checks quiet hours in the LEAD's local time, so the suite has to stand
  // at a fixed moment inside business hours. Only Date is faked — the Postgres driver
  // needs real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: MON_10_WIB })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends an approved message and records it', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:1' },
      harness.deps,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providerMessageId).toBe('true_6281234567890@c.us_OUT1')

    // The session came from the workspace's integrations row, not from the environment.
    expect(harness.sent).toEqual([
      {
        account: SESSION_A,
        to: WA,
        text: 'Halo Pak Budi, boleh saya kirim ringkasannya?',
        idempotencyKey: 'wa:send:1',
      },
    ])

    const [row] = await messagesIn(workspaceA)
    expect(row).toMatchObject({
      status: 'sent',
      provider_message_id: 'true_6281234567890@c.us_OUT1',
      thread_id: CHAT_ID,
    })
    expect(row?.sent_at).toBeInstanceOf(Date)
  })

  it('writes the audit row a send owes (rule 10)', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })

    await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:2' },
      transport(ACCEPTED).deps,
    )

    const activities = await sql<{ type: string; actor: string; channel: string; payload: Row }[]>`
      select type, actor, channel, payload from activities
      where workspace_id = ${workspaceA} and lead_id = ${leadId}`
    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({ type: 'message_sent', actor: 'system', channel: 'whatsapp' })
    expect(activities[0]?.payload).toMatchObject({
      messageId,
      provider: 'waha',
      idempotencyKey: 'wa:send:2',
    })
  })

  // Rule 4. The guard runs before the transport is even looked at, so a rejection
  // cannot reach a provider by any route.
  it('asks the guard first, and a suppressed contact never reaches the transport', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })
    await sql`insert into suppressions (workspace_id, kind, value)
              values (${workspaceA}, 'phone', ${WA})`
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:3' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('rejected_by_guard')
    if (result.error.kind !== 'rejected_by_guard') return
    expect(result.error.error).toMatchObject({ kind: 'suppression' })

    expect(harness.sent).toHaveLength(0)
    expect((await messagesIn(workspaceA))[0]?.status).toBe('approved')
  })

  it('refuses a message that was never approved', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({
      workspace: workspaceA,
      leadId,
      status: 'pending_approval',
    })
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:4' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    expect(harness.sent).toHaveLength(0)
  })

  it('sends nothing twice: the second call is refused after the first claimed it', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })
    const harness = transport(ACCEPTED)
    const input = { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:5' }

    const first = await sendMessageWith(input, harness.deps)
    const second = await sendMessageWith(input, harness.deps)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (second.ok) return
    // The guard gets there first: a sent message is not sendable.
    expect(second.error.kind).toBe('rejected_by_guard')
    expect(harness.sent).toHaveLength(1)
  })

  // The guard accepts `queued` for the queue worker that does not exist yet. The claim
  // does not: a row left at `queued` is a send whose outcome we do not know, and
  // resending it would put a second message in front of a customer.
  it('does not pick up a message left at queued', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId, status: 'queued' })
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:10' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'already_claimed', status: 'queued' })
    expect(harness.sent).toHaveLength(0)
  })

  it('refuses a message with nothing in it', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId, body: '   ' })
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:11' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('empty_body')
    expect(harness.sent).toHaveLength(0)
    expect((await messagesIn(workspaceA))[0]?.status).toBe('approved')
  })

  /**
   * An id we never got means no ack can ever match the row — `applyAck` matches on
   * `provider_message_id` — so it is frozen at `sent`. The provider's own answer is the
   * only thing a human can reconcile that against, so it has to survive somewhere.
   */
  it('keeps the provider’s answer when it came back with no message id', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })
    const harness = transport(
      ok<WhatsAppSendResult>({
        providerMessageId: null,
        unparsedResponse: { status: 201, body: 'Created' },
      }),
    )

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:12' },
      harness.deps,
    )

    expect(result.ok).toBe(true)
    const [row] = await messagesIn(workspaceA)
    expect(row).toMatchObject({ status: 'sent', provider_message_id: null })

    const activities = await sql<{ payload: Row }[]>`
      select payload from activities where workspace_id = ${workspaceA}`
    expect(activities[0]?.payload).toMatchObject({
      providerMessageId: null,
      unparsedResponse: { status: 201, body: 'Created' },
    })
  })

  /**
   * Rule 9: this function is typed `Promise<Result<…>>`, so an adapter that throws must
   * not become an exception here. And the row must stay `queued`, not `failed` — we do
   * not know whether WhatsApp got it, and `failed` is an invitation to resend something
   * a customer may already have read. `send-context.ts` bounds what a queued row costs.
   */
  it('returns a result, not an exception, when the adapter throws', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })
    const crashing: SendDeps = {
      transport: {
        provider: 'waha',
        send: async () => {
          throw new Error('socket hang up')
        },
      },
    }

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:13' },
      crashing,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('outcome_unknown')
    if (result.error.kind !== 'outcome_unknown') return
    expect(result.error.message).toContain('socket hang up')

    const [row] = await messagesIn(workspaceA)
    expect(row?.status).toBe('queued')
    expect(row?.sent_at).toBeNull()
  })

  it('leaves the message failed, and says so, when the bridge is unreachable', async () => {
    const { leadId } = await makeLead({ workspace: workspaceA })
    const messageId = await makeOutbound({ workspace: workspaceA, leadId })
    const harness = transport(err<WhatsAppSendError>({ kind: 'network', detail: 'ECONNREFUSED' }))

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:6' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('send_failed')

    const [row] = await messagesIn(workspaceA)
    expect(row?.status).toBe('failed')
    expect(row?.provider_message_id).toBeNull()

    const activities = await sql<{ type: string; actor: string }[]>`
      select type, actor from activities where workspace_id = ${workspaceA}`
    expect(activities).toEqual([{ type: 'message_failed', actor: 'system' }])
  })

  it('refuses an email without calling any transport', async () => {
    // With a usable address, so the refusal below is the channel branch and not the
    // guard turning it away for having nowhere to go.
    const { leadId } = await makeLead({ workspace: workspaceA, email: 'budi@petshop.test' })
    const [row] = await sql<{ id: string }[]>`
      insert into messages (workspace_id, lead_id, channel, direction, status, subject, body)
      values (${workspaceA}, ${leadId}, 'email', 'out', 'approved', 'Halo', 'Isi email')
      returning id`
    if (row === undefined) throw new Error('email message fixture failed')
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId: row.id, idempotencyKey: 'wa:send:7' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('channel_not_implemented')
    expect(harness.sent).toHaveLength(0)
    expect((await messagesIn(workspaceA))[0]?.status).toBe('approved')
  })

  it('refuses to send from a workspace that has not connected WhatsApp', async () => {
    await sql`update integrations set status = 'disconnected'
              where workspace_id = ${workspaceA} and provider = 'whatsapp'`
    try {
      const { leadId } = await makeLead({ workspace: workspaceA })
      const messageId = await makeOutbound({ workspace: workspaceA, leadId })
      const harness = transport(ACCEPTED)

      const result = await sendMessageWith(
        { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:8' },
        harness.deps,
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('not_connected')
      expect(harness.sent).toHaveLength(0)
      expect((await messagesIn(workspaceA))[0]?.status).toBe('approved')
    } finally {
      await sql`update integrations set status = 'connected'
                where workspace_id = ${workspaceA} and provider = 'whatsapp'`
    }
  })

  it('does not send another workspace’s message', async () => {
    const { leadId } = await makeLead({ workspace: workspaceB })
    const messageId = await makeOutbound({ workspace: workspaceB, leadId })
    const harness = transport(ACCEPTED)

    const result = await sendMessageWith(
      { workspaceId: workspaceA, messageId, idempotencyKey: 'wa:send:9' },
      harness.deps,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('rejected_by_guard')
    expect(harness.sent).toHaveLength(0)
    expect((await messagesIn(workspaceB))[0]?.status).toBe('approved')
  })
})
