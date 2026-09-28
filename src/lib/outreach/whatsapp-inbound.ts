import 'server-only'

import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '@/lib/db/drizzle'
import type { MessageStatus } from '@/lib/db/schema'
import { normalizePhone } from '@/lib/leads/normalize'

import {
  ackToStatus,
  fromChatId,
  isEcho,
  resolveSessionWorkspace,
  statusesBelow,
} from './whatsapp'
import { findWorkspacesForSession } from './whatsapp-account'

/**
 * Inbound WAHA events: a reply arrives, or a delivery ack does (SPEC §6).
 *
 * WHAT THIS MODULE MAY WRITE, AND WHY THE LIST IS SHORT. Two tables:
 * `messages` and `webhook_events`. That is the whole capability.
 *
 * It may NOT write `suppressions`, and it may NOT write `leads.status`. Both are
 * tempting here — a reply saying "STOP" should suppress the contact, a reply at all
 * should move the lead to `replied` — and both are the classification slice's job,
 * behind `classify-reply.ts` and `crm/status.ts`. The reason is not tidiness. Anyone
 * who can reach this endpoint chooses the text it receives, so a path from inbound
 * text straight into `suppressions` is a path from a forged webhook to a client's
 * entire contact list going silent, and a path into `leads.status` is a way to
 * rewrite a pipeline from outside. Deciding what a reply means is a step with its
 * own audit row; receiving one is not.
 *
 * `tests/unit/whatsapp-inbound-capability.test.ts` reads this file and the route and
 * fails if either grows an import that would make those writes possible, so the
 * restriction survives someone adding a feature here in six months.
 *
 * NO AUTO-REPLY (CLAUDE.md rule 5). Nothing here creates an outbound `messages` row
 * and nothing here calls a model. A human approves every message that leaves.
 *
 * AND IT ONLY STORES CONVERSATIONS THAT ARE OURS (owner decision, 2026-09-28). A
 * client connects their own WhatsApp account, so WAHA hands us every inbound message
 * on it — including their private chats with family. Testing against a personal
 * number on 2026-09-27 put six real private conversations into `messages` inside four
 * minutes. That is third-party personal data with no lawful basis to hold it, and the
 * rule in `.claude/rules/outreach.md` — a contact of unclear provenance is treated as
 * personal and left alone — is the one that was broken. So an inbound `message` is
 * stored only when `matchChat` finds evidence this workspace is already a party to the
 * chat. Everything else is a 200 and NOTHING is written: no `messages` row, and no
 * `webhook_events` receipt either, because `webhook_events.payload` holds the whole
 * body and therefore the message text. Same shape as the unknown-session path above it.
 */

// -----------------------------------------------------------------------------
// The payload, as WAHA sends it
// -----------------------------------------------------------------------------

const wahaPayloadSchema = z.looseObject({
  /** WhatsApp's own message id, e.g. `false_628…@c.us_3EB0…`. */
  id: z.string().min(1).max(500),
  /** Seconds since the epoch, not milliseconds. */
  timestamp: z.number().int().nonnegative().optional(),
  /** `628…@c.us` for a person, `…@g.us` for a group. */
  from: z.string().min(1).max(200).optional(),
  body: z.string().max(20_000).nullish(),
  hasMedia: z.boolean().optional(),
  ack: z.number().int().optional(),
  /** True when WhatsApp is echoing something WE sent. See `isEcho`. */
  fromMe: z.boolean().optional(),
})

export const wahaEventSchema = z.looseObject({
  event: z.string().min(1).max(100),
  session: z.string().min(1).max(200),
  payload: wahaPayloadSchema,
})

export type WahaEvent = z.infer<typeof wahaEventSchema>

/** The two events this slice handles. Everything else is acknowledged and dropped. */
const HANDLED_EVENTS = ['message', 'message.ack'] as const

const PROVIDER = 'waha'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// -----------------------------------------------------------------------------
// Outcomes
// -----------------------------------------------------------------------------

/**
 * Every outcome is a 200. A webhook that answers 4xx to something it has decided not
 * to act on only teaches the sender to retry forever.
 */
export type InboundOutcome =
  | { readonly kind: 'ignored_event'; readonly event: string }
  /** WhatsApp echoed our own outbound message back at us. See `isEcho`. */
  | { readonly kind: 'ignored_echo' }
  /** No workspace owns this session, or more than one does. Nothing was written. */
  | { readonly kind: 'unattributable'; readonly reason: 'unknown_session' | 'ambiguous_session' }
  /**
   * The chat is not one this workspace is a party to — most likely the account
   * owner's own private conversation. Nothing was written, receipt included.
   */
  | { readonly kind: 'ignored_unmatched_chat' }
  | { readonly kind: 'replayed' }
  /** Stored. `leadId` is null when the chat matched but no lead hangs off it. */
  | { readonly kind: 'stored'; readonly messageId: string; readonly leadId: string | null }
  | { readonly kind: 'ack_applied'; readonly status: MessageStatus; readonly updated: number }
  /** A PENDING ack, or one that would have moved a message backwards. */
  | { readonly kind: 'ack_ignored'; readonly ack: number }

export async function handleWahaEvent(event: WahaEvent): Promise<InboundOutcome> {
  if (!isHandled(event.event)) return { kind: 'ignored_event', event: event.event }

  // WAHA documents `message` as incoming-only, so this should never fire. It is here
  // because the cost of being wrong is asymmetric: an echo of our own text stored as
  // `direction: 'in'` and attributed to the lead becomes an input to reply
  // classification, which would read our own opener as the customer's answer to it.
  // Only for `message` — an ACK is *about* our outbound message, so every ack
  // legitimately carries a `true_` id.
  if (event.event === 'message' && isEcho(event.payload)) return { kind: 'ignored_echo' }

  // The session names the tenant. Resolved BEFORE anything is written, and a session
  // that does not resolve to exactly one workspace writes nothing at all — not even
  // a `webhook_events` receipt, which would need a workspace id we do not have.
  const resolved = await resolveSessionWorkspace(event.session, findWorkspacesForSession)
  if (!resolved.ok) {
    // Logged, because the silent version of this is the expensive one: a typo in
    // `wa:connect --session`, or WAHA renaming a session, answers every customer reply
    // with 200 and drops it, and nothing anywhere would say so.
    console.warn(
      `[whatsapp] ${resolved.error.kind}: no single workspace owns WAHA session ` +
        `"${event.session}"; event ${event.event} dropped`,
    )
    return { kind: 'unattributable', reason: resolved.error.kind }
  }
  const workspaceId = resolved.value

  // An ack is about OUR OWN outbound message and carries no third-party content, so it
  // goes straight through on `provider_message_id` as it always has.
  if (event.event !== 'message') {
    return claimThen(workspaceId, event, (tx) => applyAck(tx, workspaceId, event))
  }

  // Whose chat this is, decided BEFORE the receipt is claimed, because the receipt
  // stores the body. See the note at the top of this file.
  const chatId = event.payload.from ?? null
  const match = await matchChat(workspaceId, chatId)
  if (match === null) {
    // The diagnostic that tells us the correlation key is wrong — and the ONLY thing
    // we are allowed to keep about a chat that is not ours, so it names the session
    // and the chat id and never the body. A flood of `@lid` here means replies are
    // being dropped and the key needs revisiting, not that the rule is wrong.
    console.warn(
      `[whatsapp] unmatched chat: session "${event.session}" chat ` +
        `"${chatId ?? 'none'}" matches no outbound thread and no contact in this ` +
        `workspace; inbound message dropped, nothing written`,
    )
    return { kind: 'ignored_unmatched_chat' }
  }

  return claimThen(workspaceId, event, (tx) => storeInbound(tx, workspaceId, event, match))
}

/**
 * The idempotency claim, and the work it guards.
 *
 * Claiming first means a redelivery blocks on the unique index until this transaction
 * commits, rather than racing it. Nothing may call this for an event we have decided
 * not to keep: the receipt's `payload` column is a copy of the whole webhook body.
 */
async function claimThen(
  workspaceId: string,
  event: WahaEvent,
  work: (tx: Transaction) => Promise<InboundOutcome>,
): Promise<InboundOutcome> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(schema.webhookEvents)
      .values({
        workspaceId,
        provider: PROVIDER,
        idempotencyKey: idempotencyKeyFor(event),
        payload: event,
      })
      .onConflictDoNothing({
        target: [schema.webhookEvents.provider, schema.webhookEvents.idempotencyKey],
      })
      .returning({ id: schema.webhookEvents.id })

    const receipt = claimed[0]
    if (receipt === undefined) return { kind: 'replayed' }

    const outcome = await work(tx)

    await tx
      .update(schema.webhookEvents)
      .set({ processedAt: new Date() })
      .where(
        and(
          eq(schema.webhookEvents.workspaceId, workspaceId),
          eq(schema.webhookEvents.id, receipt.id),
        ),
      )

    return outcome
  })
}

function isHandled(event: string): boolean {
  return HANDLED_EVENTS.some((handled) => handled === event)
}

/**
 * One key per event, not per message.
 *
 * A message id alone would be wrong for acks: one outbound message produces
 * `sent`, `delivered` and `read` callbacks that all carry the same id, and keying on
 * it would swallow every ack after the first. The ack code is part of the key, and
 * the event name is too, so a `message` and a `message.ack` for the same id cannot
 * collide either.
 */
export function idempotencyKeyFor(event: WahaEvent): string {
  const ack = event.payload.ack
  const suffix = event.event === 'message.ack' ? `:${ack ?? 'none'}` : ''
  return `${event.session}:${event.event}:${event.payload.id}${suffix}`
}

// -----------------------------------------------------------------------------
// A reply arrives
// -----------------------------------------------------------------------------

/**
 * What makes a chat ours, or null when nothing does.
 *
 * `leadId` may still be null inside a match — an outbound message with no lead, or a
 * contact we know but have opened no lead for. Matched-but-unattributed is a row a
 * human can file; unmatched is a row we must not have at all.
 */
type ChatMatch = { readonly leadId: string | null }

/**
 * Two independent kinds of evidence that this workspace is already a party to the chat.
 * Either one is enough; neither means we write nothing.
 *
 *  1. **A contact in this workspace has the sender's number.** The workspace collected
 *     it as a business contact, so the provenance is known and the person is already a
 *     data subject in this CRM. The account owner's mother is not in `contacts`.
 *  2. **We have an outbound message on this exact thread.** `send.ts` writes
 *     `thread_id = toChatId(recipient)`; an inbound with the same chat id is the reply
 *     to a conversation we opened.
 *
 * Contact first, because it yields the lead attribution directly and survives the case
 * where the outbound row lost its thread. Thread second, and it carries the lead from
 * the message being answered, which is right even when the number has since changed
 * hands between contacts.
 *
 * THE KNOWN HOLE, and it is unresolved: live traffic on 2026-09-27 arrived as
 * `30589042323502@lid`, WhatsApp's opaque linked-id, which by design reveals no phone
 * number — so `fromChatId` returns null for it and it can never equal a `@c.us` thread
 * id either. Both keys therefore miss every `@lid` chat. It is plausible that replies
 * to chats WE opened come back as `@c.us` and `@lid` only appears for chats strangers
 * started, which is what the six dropped ones were; that is UNVERIFIED and needs a
 * dedicated number to check. Until then the miss is deliberate and the `console.warn`
 * in `handleWahaEvent` is how we will see it: a lost reply is recoverable and visible,
 * a stranger's private conversation in our database is neither.
 */
async function matchChat(workspaceId: string, chatId: string | null): Promise<ChatMatch | null> {
  if (chatId === null) return null

  const e164 = fromChatId(chatId)
  const contactId = e164 === null ? null : await findContactByNumber(workspaceId, e164)
  if (contactId !== null) return { leadId: await findLeadForContact(workspaceId, contactId) }

  return findOurThread(workspaceId, chatId)
}

/**
 * True, as a match, when this workspace has sent something on this chat.
 *
 * Only `direction: 'out'` rows count. An inbound row on the thread would make the
 * first stored message of a foreign chat the reason the second one is stored too.
 */
async function findOurThread(workspaceId: string, chatId: string): Promise<ChatMatch | null> {
  const [ours] = await db
    .select({ leadId: schema.messages.leadId })
    .from(schema.messages)
    // rule 6: the Drizzle handle bypasses RLS, so the tenant filter is written out.
    .where(
      and(
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.direction, 'out'),
        eq(schema.messages.threadId, chatId),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1)

  return ours === undefined ? null : { leadId: ours.leadId }
}

/**
 * Stores the inbound message, attributed to the lead `matchChat` found and to nobody
 * when it found none.
 *
 * Only ever called for a chat that matched. A sender we cannot place is not stored at
 * all any more — see the note at the top of this file for what that is protecting.
 *
 * Status `delivered`, not `replied`: `delivered` describes this row — the message
 * reached us — while `replied` is a state the OUTBOUND message it answers moves to,
 * and moving it there is a judgement the classification slice makes.
 */
async function storeInbound(
  tx: Transaction,
  workspaceId: string,
  event: WahaEvent,
  match: ChatMatch,
): Promise<InboundOutcome> {
  const leadId = match.leadId

  const [row] = await tx
    .insert(schema.messages)
    .values({
      workspaceId,
      leadId,
      channel: 'whatsapp',
      direction: 'in',
      status: 'delivered',
      body: event.payload.body ?? null,
      providerMessageId: event.payload.id,
      // The conversation, in the same form `send.ts` writes it, so a reply and what
      // it answers share a thread even when the lead could not be identified.
      threadId: event.payload.from ?? null,
      sentAt: timestampOf(event.payload.timestamp),
    })
    .returning({ id: schema.messages.id })

  if (row === undefined) throw new Error('inbound message insert returned no row')
  return { kind: 'stored', messageId: row.id, leadId }
}

/** WAHA sends seconds. `new Date(seconds)` would put every reply in January 1970. */
function timestampOf(timestamp: number | undefined): Date {
  if (timestamp === undefined) return new Date()
  const at = new Date(timestamp * 1000)
  return Number.isNaN(at.getTime()) ? new Date() : at
}

/**
 * The contact this number belongs to, inside this workspace only.
 *
 * `whatsapp` or `phone`, because a contact scraped with one landline-shaped number
 * may still reply from it, and both columns hold the same normalised E.164.
 *
 * Exactly one matching contact, or nothing. Two contacts in one workspace sharing a
 * number is a deduplication problem, and picking one of them would file the
 * conversation against a coin flip — an unattributed row a human can fix is better
 * than a confidently wrong one nobody notices. A number that is ambiguous here can
 * still match on the thread, which names one conversation and not two.
 */
async function findContactByNumber(workspaceId: string, e164: string): Promise<string | null> {
  const phone = normalizePhone(e164)
  if (phone === null) return null

  const contacts = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    // rule 6: the Drizzle handle bypasses RLS. This filter is the tenant boundary
    // the whole session resolution above exists to establish.
    .where(
      and(
        eq(schema.contacts.workspaceId, workspaceId),
        or(eq(schema.contacts.whatsapp, phone), eq(schema.contacts.phone, phone)),
      ),
    )
    .limit(2)

  const contact = contacts[0]
  if (contact === undefined || contacts.length > 1) return null
  return contact.id
}

/** The newest lead for a contact, or none. */
async function findLeadForContact(
  workspaceId: string,
  contactId: string,
): Promise<string | null> {
  const [lead] = await db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(
      and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.contactId, contactId)),
    )
    // The newest lead for this contact. An older, closed lead is not what a reply
    // today is about.
    .orderBy(desc(schema.leads.createdAt))
    .limit(1)

  return lead?.id ?? null
}

// -----------------------------------------------------------------------------
// A delivery ack arrives
// -----------------------------------------------------------------------------

/**
 * Moves one outbound message forward, and only forward.
 *
 * Acks arrive out of order often enough to matter, so the update names the statuses
 * it is allowed to overwrite instead of setting the new one unconditionally
 * (`statusesBelow`). Without that, a late `delivered` would walk a message that has
 * already been read — or replied to — back down the ladder, and the approval queue
 * would start showing progress that had already happened.
 *
 * An ack for a `provider_message_id` this workspace does not have updates nothing and
 * is still a success: WAHA reports acks for messages sent from the phone by hand,
 * which we never recorded and have no business inventing a row for.
 */
async function applyAck(
  tx: Transaction,
  workspaceId: string,
  event: WahaEvent,
): Promise<InboundOutcome> {
  const ack = event.payload.ack
  if (ack === undefined) return { kind: 'ack_ignored', ack: 0 }

  const status = ackToStatus(ack)
  if (status === null) return { kind: 'ack_ignored', ack }

  const overwritable = statusesBelow(status)
  if (overwritable.length === 0) return { kind: 'ack_ignored', ack }

  const updated = await tx
    .update(schema.messages)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.providerMessageId, event.payload.id),
        eq(schema.messages.direction, 'out'),
        inArray(schema.messages.status, [...overwritable]),
      ),
    )
    .returning({ id: schema.messages.id })

  return { kind: 'ack_applied', status, updated: updated.length }
}
