import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { guardSend, loadSendContext } from '@/lib/outreach/send-context'

import { openDatabase } from './helpers'

/**
 * The send guard's loader against real Postgres.
 *
 * `tests/unit/send-guard.test.ts` proves what each check decides. This file proves
 * the checks are fed the truth: that "sent today" means today in the workspace's
 * timezone, that a queued message counts, that a suppression in another workspace
 * does not match, that a duplicate is found through a second lead with the same
 * number — and that when the context cannot be loaded, the guard says no.
 *
 * Every rejection below is asserted through `guardSend`, the call a sender makes,
 * so these are the same verdicts a real send would get.
 *
 * Its own workspaces, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'send-guard-test-workspace'
const OTHER = `${SLUG}-other`

/** Monday 2026-09-14, 10:00 WIB. The workspace's day began at 2026-09-13T17:00Z. */
const NOW = new Date('2026-09-14T03:00:00Z')
const TODAY_EARLIER = new Date('2026-09-14T02:00:00Z')
const YESTERDAY_LATE = new Date('2026-09-13T16:00:00Z')
const SUNDAY_10_WIB = new Date('2026-09-20T03:00:00Z')
/** Saturday 2026-09-12, 10:00 WIB — two days before NOW, so any 24h window has passed. */
const TWO_DAYS_BEFORE = new Date('2026-09-12T03:00:00Z')

const WA = '+6281234567890'

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string
let campaignId: string

type Fixture = { leadId: string; contactId: string }

async function makeLead(options: {
  workspace?: string
  name?: string
  whatsapp?: string | null
  email?: string | null
  city?: string
  campaign?: string | null
} = {}): Promise<Fixture> {
  const ws = options.workspace ?? workspaceId
  const name = options.name ?? 'Petshop Bintang'

  const [company] = await sql<{ id: string }[]>`
    insert into companies (workspace_id, name, city, country)
    values (${ws}, ${name}, ${options.city ?? 'Surabaya'}, 'ID') returning id`
  if (company === undefined) throw new Error('company fixture failed')

  const whatsapp = options.whatsapp === undefined ? WA : options.whatsapp
  const [contact] = await sql<{ id: string }[]>`
    insert into contacts (workspace_id, company_id, whatsapp, phone, email)
    values (${ws}, ${company.id}, ${whatsapp}, ${whatsapp}, ${options.email ?? null})
    returning id`
  if (contact === undefined) throw new Error('contact fixture failed')

  const campaign = options.campaign === undefined ? campaignId : options.campaign
  const [lead] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, campaign_id, status)
    values (${ws}, ${company.id}, ${contact.id}, ${campaign}, 'qualified') returning id`
  if (lead === undefined) throw new Error('lead fixture failed')

  return { leadId: lead.id, contactId: contact.id }
}

async function makeMessage(options: {
  leadId: string
  workspace?: string
  channel?: 'email' | 'whatsapp'
  direction?: 'out' | 'in'
  status?: string
  templateId?: string | null
  subject?: string | null
  sentAt?: Date | null
  /** When a `queued` row took its claim. Both queued branches are bounded by it. */
  updatedAt?: Date
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into messages (workspace_id, lead_id, channel, direction, status, template_id, subject,
                          sent_at, updated_at)
    values (${options.workspace ?? workspaceId}, ${options.leadId}, ${options.channel ?? 'whatsapp'},
            ${options.direction ?? 'out'}, ${options.status ?? 'approved'},
            ${options.templateId === undefined ? 'sapaan_pertama' : options.templateId},
            ${options.subject ?? null}, ${options.sentAt ?? null},
            ${options.updatedAt ?? new Date()})
    returning id`
  if (row === undefined) throw new Error('message fixture failed')
  return row.id
}

async function verdict(messageId: string, now: Date = NOW): Promise<string> {
  const result = await guardSend({ workspaceId, messageId, now })
  return result.ok ? 'allowed' : result.error.kind
}

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Send Guard Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Send Guard Other', ${OTHER}) returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')
  workspaceId = ws.id
  otherWorkspaceId = other.id
})

beforeEach(async () => {
  await sql`delete from companies where workspace_id in (${workspaceId}, ${otherWorkspaceId})`
  await sql`delete from messages where workspace_id in (${workspaceId}, ${otherWorkspaceId})`
  await sql`delete from suppressions where workspace_id in (${workspaceId}, ${otherWorkspaceId})`
  await sql`delete from campaigns where workspace_id in (${workspaceId}, ${otherWorkspaceId})`
  await sql`
    update workspaces set timezone = 'Asia/Jakarta', daily_wa_limit = 100, daily_email_limit = 200
    where id in (${workspaceId}, ${otherWorkspaceId})`

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (workspace_id, name) values (${workspaceId}, 'Sapaan Petshop') returning id`
  if (campaign === undefined) throw new Error('campaign fixture failed')
  campaignId = campaign.id
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('a compliant message', () => {
  it('is allowed, addressed to the normalised WhatsApp number', async () => {
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })

    const result = await guardSend({ workspaceId, messageId, now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.recipient).toBe(WA)
    expect(result.value.timeZones).toEqual(['Asia/Jakarta'])
  })
})

describe('tenant isolation', () => {
  it("cannot see another workspace's message at all", async () => {
    const { leadId } = await makeLead({ workspace: otherWorkspaceId })
    const theirs = await makeMessage({ leadId, workspace: otherWorkspaceId })
    expect(await verdict(theirs)).toBe('message_not_found')
  })

  it("does not match another workspace's suppression list", async () => {
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    await sql`
      insert into suppressions (workspace_id, kind, value) values (${otherWorkspaceId}, 'phone', ${WA})`
    expect(await verdict(messageId)).toBe('allowed')
  })

  it("does not count another workspace's sends against this one's limit", async () => {
    await sql`update workspaces set daily_wa_limit = 1 where id = ${workspaceId}`
    const mine = await makeLead()
    const theirs = await makeLead({ workspace: otherWorkspaceId, whatsapp: '+6281111111111' })
    await makeMessage({
      leadId: theirs.leadId,
      workspace: otherWorkspaceId,
      status: 'sent',
      sentAt: TODAY_EARLIER,
    })

    const messageId = await makeMessage({ leadId: mine.leadId })
    expect(await verdict(messageId)).toBe('allowed')
  })
})

describe('1 · suppression', () => {
  it('matches a stored phone suppression', async () => {
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    await sql`
      insert into suppressions (workspace_id, kind, value) values (${workspaceId}, 'phone', ${WA})`
    expect(await verdict(messageId)).toBe('suppression')
  })

  it('stops an email because the same contact said STOP on WhatsApp', async () => {
    const { leadId } = await makeLead({ email: 'budi@petshopbintang.id' })
    const messageId = await makeMessage({
      leadId,
      channel: 'email',
      templateId: null,
      subject: 'Halo',
    })
    await sql`
      insert into suppressions (workspace_id, kind, value) values (${workspaceId}, 'phone', ${WA})`
    expect(await verdict(messageId)).toBe('suppression')
  })

  it("refuses a contact whose opt_out_at is set", async () => {
    const { leadId, contactId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    await sql`update contacts set opt_out_at = now() where id = ${contactId}`
    expect(await verdict(messageId)).toBe('suppression')
  })
})

describe('2 · daily_limit', () => {
  it("counts today's sends in the workspace's own timezone, and resets at its midnight", async () => {
    await sql`update workspaces set daily_wa_limit = 2 where id = ${workspaceId}`
    for (const [i, sentAt] of [TODAY_EARLIER, TODAY_EARLIER, YESTERDAY_LATE].entries()) {
      const other = await makeLead({ name: `Petshop ${i}`, whatsapp: `+628111111111${i}` })
      await makeMessage({ leadId: other.leadId, status: 'sent', sentAt })
    }

    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })

    // 16:00Z on the 13th is 23:00 WIB on Sunday — yesterday, not today. Two today.
    const context = await loadSendContext(workspaceId, messageId, NOW)
    expect(context?.sentToday).toBe(2)
    // Midnight WIB on the 15th.
    expect(context?.dayEndsAt).toEqual(new Date('2026-09-14T17:00:00Z'))

    const result = await guardSend({ workspaceId, messageId, now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('daily_limit')
  })

  it('counts a queued message that has not gone yet', async () => {
    await sql`update workspaces set daily_wa_limit = 1 where id = ${workspaceId}`
    const other = await makeLead({ name: 'Petshop Antre', whatsapp: '+6281111111119' })
    await makeMessage({ leadId: other.leadId, status: 'queued', updatedAt: TODAY_EARLIER })

    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId)).toBe('daily_limit')
  })

  /**
   * A row still `queued` from a previous day is a send whose outcome was lost, not one
   * about to go. It has no `sent_at`, so counting it would count it every day for the
   * rest of time: 100 of them — the default limit — would reject every WhatsApp send in
   * the workspace permanently, with a `retryAt` of the next midnight that can never
   * help. The quota has to heal itself at the workspace's own midnight.
   */
  it('stops counting a queued message once the workspace day it was claimed in has ended', async () => {
    await sql`update workspaces set daily_wa_limit = 1 where id = ${workspaceId}`
    const other = await makeLead({ name: 'Petshop Macet', whatsapp: '+6281111111117' })
    await makeMessage({ leadId: other.leadId, status: 'queued', updatedAt: YESTERDAY_LATE })

    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId)).toBe('allowed')
  })

  it('does not count the message being judged against itself', async () => {
    await sql`update workspaces set daily_wa_limit = 1 where id = ${workspaceId}`
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId, status: 'queued' })
    expect(await verdict(messageId)).toBe('allowed')
  })

  it('keeps the email and WhatsApp quotas separate', async () => {
    await sql`update workspaces set daily_wa_limit = 1 where id = ${workspaceId}`
    const other = await makeLead({ name: 'Petshop Email', whatsapp: '+6281111111118' })
    await makeMessage({
      leadId: other.leadId,
      channel: 'email',
      status: 'sent',
      sentAt: TODAY_EARLIER,
      templateId: null,
    })

    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId)).toBe('allowed')
  })
})

describe('3 · cooldown', () => {
  it('finds a message sent to the same contact through a different lead', async () => {
    const first = await makeLead()
    const [second] = await sql<{ id: string }[]>`
      insert into leads (workspace_id, company_id, contact_id, status)
      select workspace_id, company_id, id, 'qualified' from contacts where id = ${first.contactId}
      returning id`
    if (second === undefined) throw new Error('second lead fixture failed')

    await makeMessage({ leadId: second.id, status: 'sent', sentAt: TODAY_EARLIER, templateId: 'lain' })
    const messageId = await makeMessage({ leadId: first.leadId })

    const result = await guardSend({ workspaceId, messageId, now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('cooldown')
    if (result.error.kind !== 'cooldown') return
    expect(result.error.retryAt).toEqual(new Date(TODAY_EARLIER.getTime() + 86_400_000))
  })

  /**
   * A queued row occupies the contact's 24 hours from the moment it was CLAIMED, not
   * from the moment we ask. Reading it as "now" made a lost send permanently recent, so
   * one of them left a contact uncontactable on every channel forever behind a
   * rejection that promised a retry time that never arrived.
   */
  it('counts a queued message from the time it was claimed', async () => {
    const { leadId, contactId } = await makeLead()
    const [second] = await sql<{ id: string }[]>`
      insert into leads (workspace_id, company_id, contact_id, status)
      select workspace_id, company_id, id, 'qualified' from contacts where id = ${contactId}
      returning id`
    if (second === undefined) throw new Error('second lead fixture failed')
    await makeMessage({
      leadId: second.id,
      status: 'queued',
      templateId: 'lain',
      updatedAt: TODAY_EARLIER,
    })

    const messageId = await makeMessage({ leadId })
    const result = await guardSend({ workspaceId, messageId, now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('cooldown')
    if (result.error.kind !== 'cooldown') return
    // The claim time plus 24h — not the moment of asking plus 24h, which would move
    // every time anybody asked.
    expect(result.error.retryAt).toEqual(new Date(TODAY_EARLIER.getTime() + 86_400_000))
  })

  it('lets the cooldown expire on a message that has been queued for days', async () => {
    const { leadId, contactId } = await makeLead()
    const [second] = await sql<{ id: string }[]>`
      insert into leads (workspace_id, company_id, contact_id, status)
      select workspace_id, company_id, id, 'qualified' from contacts where id = ${contactId}
      returning id`
    if (second === undefined) throw new Error('second lead fixture failed')
    await makeMessage({
      leadId: second.id,
      status: 'queued',
      templateId: 'lain',
      updatedAt: TWO_DAYS_BEFORE,
    })

    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId)).toBe('allowed')
  })

  it('ignores an inbound message — a reply is not something we sent', async () => {
    const { leadId } = await makeLead()
    await makeMessage({ leadId, direction: 'in', status: 'replied', sentAt: TODAY_EARLIER })
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId)).toBe('allowed')
  })

  it('ignores a send that failed', async () => {
    const { leadId } = await makeLead()
    await makeMessage({ leadId, status: 'failed', sentAt: TODAY_EARLIER, templateId: 'lain' })
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId)).toBe('allowed')
  })
})

describe('4 · duplicate', () => {
  it('finds one shop scraped as two leads getting the same opener', async () => {
    // Two leads, two contact rows, one WhatsApp number, one campaign.
    const earlier = await makeLead({ name: 'Petshop Bintang Surabaya' })
    const later = await makeLead({ name: 'Petshop Bintang' })

    // Sent more than 24h ago, so the cooldown is clear and only the duplicate
    // check can refuse it.
    await makeMessage({
      leadId: earlier.leadId,
      status: 'sent',
      sentAt: new Date('2026-09-10T03:00:00Z'),
    })
    const messageId = await makeMessage({ leadId: later.leadId })

    expect(await verdict(messageId)).toBe('duplicate')
  })

  it('lets a different template through — that is the next sequence step', async () => {
    const earlier = await makeLead({ name: 'Petshop Bintang Surabaya' })
    const later = await makeLead({ name: 'Petshop Bintang' })
    await makeMessage({
      leadId: earlier.leadId,
      status: 'sent',
      sentAt: new Date('2026-09-10T03:00:00Z'),
      templateId: 'sapaan_pertama',
    })
    const messageId = await makeMessage({ leadId: later.leadId, templateId: 'tindak_lanjut' })

    expect(await verdict(messageId)).toBe('allowed')
  })

  it('does not look across campaigns', async () => {
    const [otherCampaign] = await sql<{ id: string }[]>`
      insert into campaigns (workspace_id, name) values (${workspaceId}, 'Kampanye Lain') returning id`
    if (otherCampaign === undefined) throw new Error('campaign fixture failed')

    const earlier = await makeLead({ name: 'Petshop Bintang Surabaya', campaign: otherCampaign.id })
    const later = await makeLead({ name: 'Petshop Bintang' })
    await makeMessage({
      leadId: earlier.leadId,
      status: 'sent',
      sentAt: new Date('2026-09-10T03:00:00Z'),
    })
    const messageId = await makeMessage({ leadId: later.leadId })

    expect(await verdict(messageId)).toBe('allowed')
  })
})

describe('5 · approval', () => {
  it('refuses a message still pending approval', async () => {
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId, status: 'pending_approval' })
    expect(await verdict(messageId)).toBe('approval')
  })
})

describe('6 · quiet_hours', () => {
  it("reads the lead's city from its company and refuses on a Sunday", async () => {
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId, SUNDAY_10_WIB)).toBe('quiet_hours')
  })

  it("uses the lead's zone even when the workspace's disagrees", async () => {
    // 07:30 WIB is 09:30 in Jayapura. The workspace sits in WIB; the lead does not.
    const { leadId } = await makeLead({ city: 'Jayapura' })
    const messageId = await makeMessage({ leadId })
    expect(await verdict(messageId, new Date('2026-09-14T00:30:00Z'))).toBe('allowed')
  })
})

describe('failing closed', () => {
  it('returns guard_failed, never an allowed send, when the context cannot load', async () => {
    const { leadId } = await makeLead()
    const messageId = await makeMessage({ leadId })
    await sql`update workspaces set timezone = 'Not/A_Zone' where id = ${workspaceId}`

    expect(await verdict(messageId)).toBe('guard_failed')
  })

  it('refuses a message with no lead behind it for want of a recipient', async () => {
    const [orphan] = await sql<{ id: string }[]>`
      insert into messages (workspace_id, channel, direction, status)
      values (${workspaceId}, 'whatsapp', 'out', 'approved') returning id`
    if (orphan === undefined) throw new Error('orphan fixture failed')

    // No lead means no company, so no city — the guard cannot place the lead in
    // time and refuses before it ever reaches the missing address.
    expect(await verdict(orphan.id)).toBe('quiet_hours')
  })
})
