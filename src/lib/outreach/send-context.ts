import 'server-only'

import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db/drizzle'
import { type Result, err } from '@/lib/types/result'

import {
  type SendAllowed,
  type SendContext,
  type SendRejection,
  type SuppressionKey,
  evaluateSend,
  recipientFor,
  suppressionKeysFor,
} from './send-guard'

/**
 * Loads what `send-guard.ts` needs to judge one message, then asks it.
 *
 * `guardSend` is the call a sender makes. It is the I/O half of the guard, split
 * out only because the pure half must be importable by a test with no database
 * (see the header of `send-guard.ts`). There is still exactly one guard: this file
 * decides nothing, it fetches, and every verdict comes from `evaluateSend`.
 *
 * Every query below runs on the Drizzle handle, which bypasses RLS, so every one
 * of them filters `workspace_id` — joins included. A send guard that counted
 * another tenant's messages against this tenant's daily limit, or matched another
 * tenant's suppression list, would be wrong in a way nobody would notice until a
 * customer did (CLAUDE.md rule 6, `.claude/rules/data.md`).
 *
 * It fails closed. Any error loading the context — a dropped connection, an invalid
 * workspace timezone — returns `guard_failed`, never an allowed send. A guard that
 * cannot run has not said yes.
 */

export type GuardSendInput = {
  readonly workspaceId: string
  readonly messageId: string
  /** Defaults to the current time. Pass the scheduled time to pre-check a send. */
  readonly now?: Date
}

export type GuardSendError =
  | SendRejection
  | { readonly kind: 'message_not_found' }
  | { readonly kind: 'guard_failed'; readonly message: string }

/** Outbound statuses that consume a day's quota and occupy the contact's 24h. */
const COUNTED_STATUSES = ['queued', 'sent', 'delivered', 'opened', 'replied'] as const

export async function guardSend(
  input: GuardSendInput,
): Promise<Result<SendAllowed, GuardSendError>> {
  const now = input.now ?? new Date()

  let loaded: SendContext | null
  try {
    loaded = await loadSendContext(input.workspaceId, input.messageId, now)
  } catch (error: unknown) {
    return err({
      kind: 'guard_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (loaded === null) return err({ kind: 'message_not_found' })
  return evaluateSend(loaded, now)
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

/**
 * Builds the `SendContext` for one message, or null when the message does not
 * exist in this workspace.
 *
 * Exported for the integration suite, which checks each field against rows it
 * wrote. Senders call `guardSend`.
 */
export async function loadSendContext(
  workspaceId: string,
  messageId: string,
  now: Date,
): Promise<SendContext | null> {
  const [row] = await db
    .select({
      id: schema.messages.id,
      channel: schema.messages.channel,
      direction: schema.messages.direction,
      status: schema.messages.status,
      templateId: schema.messages.templateId,
      subject: schema.messages.subject,
      leadId: schema.leads.id,
      campaignId: schema.leads.campaignId,
      contactId: schema.contacts.id,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      whatsapp: schema.contacts.whatsapp,
      optOutAt: schema.contacts.optOutAt,
      companyDomain: schema.companies.domain,
      city: schema.companies.city,
      country: schema.companies.country,
      timezone: schema.workspaces.timezone,
      dailyEmailLimit: schema.workspaces.dailyEmailLimit,
      dailyWaLimit: schema.workspaces.dailyWaLimit,
    })
    .from(schema.messages)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.messages.workspaceId))
    .leftJoin(
      schema.leads,
      and(
        eq(schema.leads.id, schema.messages.leadId),
        eq(schema.leads.workspaceId, workspaceId),
      ),
    )
    .leftJoin(
      schema.contacts,
      and(
        eq(schema.contacts.id, schema.leads.contactId),
        eq(schema.contacts.workspaceId, workspaceId),
      ),
    )
    .leftJoin(
      schema.companies,
      and(
        eq(schema.companies.id, schema.leads.companyId),
        eq(schema.companies.workspaceId, workspaceId),
      ),
    )
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.workspaceId, workspaceId)))
    .limit(1)

  if (row === undefined) return null

  const recipient = { email: row.email, phone: row.phone, whatsapp: row.whatsapp }
  const dailyLimit = row.channel === 'email' ? row.dailyEmailLimit : row.dailyWaLimit

  const [matchedSuppressions, quota, lastSentToContactAt, duplicateOfMessageId] =
    await Promise.all([
      findSuppressions(workspaceId, suppressionKeysFor(recipient, row.companyDomain)),
      countSentToday(workspaceId, messageId, row.channel, row.timezone, now),
      findLastSentToContact(workspaceId, messageId, row.leadId, row.contactId, now),
      row.campaignId === null
        ? Promise.resolve(null)
        : findDuplicate(workspaceId, {
            messageId,
            campaignId: row.campaignId,
            channel: row.channel,
            recipient: recipientFor(row.channel, recipient),
            templateId: row.templateId,
            subject: row.subject,
          }),
    ])

  return {
    messageId: row.id,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    recipient,
    optOutAt: row.optOutAt,
    companyDomain: row.companyDomain,
    matchedSuppressions,
    sentToday: quota.sentToday,
    dailyLimit,
    dayEndsAt: quota.dayEndsAt,
    lastSentToContactAt,
    duplicateOfMessageId,
    city: row.city,
    country: row.country,
  }
}

async function findSuppressions(
  workspaceId: string,
  keys: readonly SuppressionKey[],
): Promise<SuppressionKey[]> {
  if (keys.length === 0) return []

  return db
    .select({ kind: schema.suppressions.kind, value: schema.suppressions.value })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.workspaceId, workspaceId),
        or(
          ...keys.map((key) =>
            and(eq(schema.suppressions.kind, key.kind), eq(schema.suppressions.value, key.value)),
          ),
        ),
      ),
    )
}

/**
 * Today's outbound count on this channel, and when "today" ends.
 *
 * "Today" is the WORKSPACE's day, not the lead's: the daily limit is the
 * workspace's quota with its provider, so it resets at the workspace's midnight.
 * Quiet hours are the lead's; quotas are ours.
 *
 * A queued message counts even though it has no `sent_at` yet — it is committed to
 * go, and not counting it is how a burst of approvals sails past the limit. The
 * message being judged is excluded, or a queued message would count against itself.
 */
async function countSentToday(
  workspaceId: string,
  messageId: string,
  channel: SendContext['channel'],
  timezone: string,
  now: Date,
): Promise<{ sentToday: number; dayEndsAt: Date }> {
  // ISO string, not the Date itself. A Date inside a raw `sql` template skips
  // Drizzle's column mapping and is sent as `String(date)` — "Mon Sep 14 2026
  // 10:00:00 GMT+0700 (Western Indonesia Time)" — which Postgres cannot parse.
  const at = now.toISOString()
  const dayStart = sql`(date_trunc('day', ${at}::timestamptz at time zone ${timezone}) at time zone ${timezone})`

  // An aggregate with no GROUP BY returns exactly one row even when nothing
  // matches, so an empty workspace still gets its count (0) and its day end.
  const [row] = await db
    .select({
      sentToday: sql<number>`count(*) filter (
        where ${schema.messages.sentAt} >= ${dayStart}
           or ${schema.messages.status} = 'queued'
      )::int`,
      // Epoch seconds rather than `::text`: Postgres renders timestamptz as
      // "2026-09-14 17:00:00+00", a shape `new Date()` is not required to accept.
      dayEndsAt: sql<number>`extract(epoch from ${dayStart} + interval '1 day')::float8`,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.channel, channel),
        eq(schema.messages.direction, 'out'),
        ne(schema.messages.id, messageId),
      ),
    )

  if (row === undefined) throw new Error('daily quota query returned no row')

  const dayEndsAt = new Date(row.dayEndsAt * 1000)
  if (Number.isNaN(dayEndsAt.getTime())) throw new Error('daily quota query returned no day end')

  return { sentToday: row.sentToday, dayEndsAt }
}

/**
 * The latest outbound message to this contact, across every lead that points at
 * them and every channel.
 *
 * Keyed by contact rather than lead because the rule is "per contact": one person
 * reachable through two leads is still one person who got a message this morning.
 * With no contact, the lead is the narrowest identity there is.
 *
 * A queued message counts as sent now, for the same reason it counts against the
 * quota.
 */
async function findLastSentToContact(
  workspaceId: string,
  messageId: string,
  leadId: string | null,
  contactId: string | null,
  now: Date,
): Promise<Date | null> {
  let identity
  if (contactId !== null) identity = eq(schema.leads.contactId, contactId)
  else if (leadId !== null) identity = eq(schema.leads.id, leadId)
  else return null

  const [row] = await db
    .select({
      last: sql<number | null>`extract(epoch from max(
        case when ${schema.messages.status} = 'queued'
             then ${now.toISOString()}::timestamptz
             else ${schema.messages.sentAt}
        end
      ))::float8`,
    })
    .from(schema.messages)
    .innerJoin(
      schema.leads,
      and(
        eq(schema.leads.id, schema.messages.leadId),
        eq(schema.leads.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.direction, 'out'),
        ne(schema.messages.id, messageId),
        inArray(schema.messages.status, [...COUNTED_STATUSES]),
        identity,
      ),
    )

  if (row === undefined || row.last === null) return null
  const last = new Date(row.last * 1000)
  return Number.isNaN(last.getTime()) ? null : last
}

type DuplicateQuery = {
  readonly messageId: string
  readonly campaignId: string
  readonly channel: SendContext['channel']
  readonly recipient: string | null
  readonly templateId: string | null
  readonly subject: string | null
}

/**
 * Another message of the same campaign, with the same content, already sent or
 * queued to the same address.
 *
 * "Same content" is the WhatsApp template or the email subject — what a recipient
 * would recognise as having received twice. A later sequence step uses a different
 * template or subject and passes; the cooldown is what spaces those out.
 *
 * Matched on the normalised ADDRESS rather than the lead, because the case this
 * exists for is one shop scraped as two leads in one campaign: two lead ids, one
 * WhatsApp number, one owner who would get the same opener twice.
 */
async function findDuplicate(workspaceId: string, query: DuplicateQuery): Promise<string | null> {
  if (query.recipient === null) return null

  const address =
    query.channel === 'email'
      ? sql`lower(trim(${schema.contacts.email})) = ${query.recipient}`
      : eq(schema.contacts.whatsapp, query.recipient)

  const [row] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .innerJoin(
      schema.leads,
      and(
        eq(schema.leads.id, schema.messages.leadId),
        eq(schema.leads.workspaceId, workspaceId),
      ),
    )
    .innerJoin(
      schema.contacts,
      and(
        eq(schema.contacts.id, schema.leads.contactId),
        eq(schema.contacts.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.messages.workspaceId, workspaceId),
        ne(schema.messages.id, query.messageId),
        eq(schema.messages.direction, 'out'),
        eq(schema.messages.channel, query.channel),
        inArray(schema.messages.status, [...COUNTED_STATUSES]),
        eq(schema.leads.campaignId, query.campaignId),
        address,
        // Cast, because a bare NULL parameter has no type for Postgres to infer.
        sql`${schema.messages.templateId} is not distinct from ${query.templateId}::text`,
        sql`${schema.messages.subject} is not distinct from ${query.subject}::text`,
      ),
    )
    .limit(1)

  return row?.id ?? null
}
