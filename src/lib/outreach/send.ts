import 'server-only'

import { and, eq } from 'drizzle-orm'

import { writeActivity } from '@/lib/crm/activity'
import { db, schema } from '@/lib/db/drizzle'
import type { MessageStatus } from '@/lib/db/schema'
import { type Result, err, ok } from '@/lib/types/result'

import { type GuardSendError, guardSend } from './send-context'
import type { Channel } from './send-guard'
import {
  type WhatsAppSendError,
  type WhatsAppTransport,
  toChatId,
} from './whatsapp'
import { findWhatsAppAccount, wahaTransportFromEnv } from './whatsapp-account'

/**
 * The single entry point for sending anything (SPEC §6).
 *
 * `sendMessage` → `guardSend` → provider adapter → `messages.status` + an
 * `activities` row. Nothing else in the codebase may call a transport, and there is
 * no argument, flag or mode here that skips the guard: the guard runs first on every
 * path, including the paths that then fail for an unrelated reason. That ordering is
 * CLAUDE.md rule 4 and it is why the email branch below refuses before it would
 * otherwise have had to know anything about Gmail.
 *
 * WhatsApp only, for now. Email returns `channel_not_implemented` and makes no
 * network call — a stub that "sent" an email by logging it would be a send path that
 * nobody had audited.
 *
 * WHAT MAKES A REPLAY SAFE. Not the `idempotencyKey`: WAHA has nowhere to put one.
 * It is the status claim — a single conditional UPDATE from `approved` to `queued`
 * that Postgres serialises on the row. Two concurrent calls, or a script run twice,
 * produce exactly one winner and the loser gets `already_claimed` without touching
 * the transport. The key is what the audit row and the Cloud API adapter are keyed
 * on, and it is deliberately not load-bearing for the thing that must not happen
 * twice.
 *
 * A message stuck at `queued` is NOT re-claimable here. It means a send whose
 * outcome we do not know — the process died between the transport call and the
 * update — and resending it would put a second message in front of a customer to
 * save one manual look. Requeueing is the queue slice's problem, with the provider's
 * own message list to reconcile against.
 *
 * What that costs is bounded, and it did not used to be. Review found that a stuck
 * row consumed the workspace's daily quota and held its contact's 24-hour cooldown
 * FOREVER — `sent_at` stays null, so neither check could ever age it out, and 100 of
 * them (the default `daily_wa_limit`) would reject every WhatsApp send in the
 * workspace permanently. Both checks in `send-context.ts` now bound the `queued`
 * branch by `updated_at`, which is when the claim below was taken, so the quota heals
 * at the workspace's next midnight and the cooldown expires after its 24 hours.
 * Leaving a row `queued` is now a thing to reconcile, not a thing that spreads.
 *
 * The transport is injected in tests, the same shape `draft.ts` uses for the model,
 * so every branch below is provable without a WAHA instance.
 */

export type SendMessageInput = {
  readonly workspaceId: string
  readonly messageId: string
  /** CLAUDE.md rule 7. Recorded in the message's activity row — see `claim`. */
  readonly idempotencyKey: string
}

export type SendMessageSuccess = {
  readonly messageId: string
  readonly channel: Channel
  /** E.164, as the guard normalised it. */
  readonly recipient: string
  readonly provider: WhatsAppTransport['provider']
  /** Null when the provider accepted the message without returning an id. */
  readonly providerMessageId: string | null
  readonly sentAt: Date
}

export type SendMessageError =
  /** The guard said no. Its rejection is passed through untouched, reason and all. */
  | { readonly kind: 'rejected_by_guard'; readonly error: GuardSendError }
  | { readonly kind: 'channel_not_implemented'; readonly channel: Channel }
  | { readonly kind: 'message_not_found' }
  /** Nothing to send. A WhatsApp message with no text is not a message. */
  | { readonly kind: 'empty_body' }
  /**
   * The message has no lead, so no `activities` row could be written for it. The
   * guard makes this unreachable — a message with no lead has no contact and so no
   * recipient — and it is an error rather than a silent skip because a send with no
   * audit trail is worse than no send (rule 10).
   */
  | { readonly kind: 'no_lead' }
  | { readonly kind: 'not_connected'; readonly detail: string }
  | { readonly kind: 'transport_not_configured'; readonly missing: readonly string[] }
  /** Another call already claimed it, or it is not at `approved` any more. */
  | { readonly kind: 'already_claimed'; readonly status: MessageStatus }
  /**
   * The provider refused or could not be reached. Nothing went out. The row is left at
   * `failed` when `recorded` is true; when it is false the failure itself could not be
   * written and the row is still `queued`.
   */
  | { readonly kind: 'send_failed'; readonly error: WhatsAppSendError; readonly recorded: boolean }
  /** A read failed before anything was claimed. Nothing went out. */
  | { readonly kind: 'load_failed'; readonly message: string }
  /**
   * The message may or may not have reached WhatsApp, and the row is left at `queued`.
   * A caller must NOT retry on this: `queued` means "outcome unknown", and the only
   * safe resolution is a human comparing the provider's own message list.
   */
  | {
      readonly kind: 'outcome_unknown'
      readonly providerMessageId: string | null
      readonly message: string
    }

export type SendDeps = {
  readonly transport: WhatsAppTransport
}

export async function sendMessage(
  input: SendMessageInput,
): Promise<Result<SendMessageSuccess, SendMessageError>> {
  // The guard runs before the transport is even looked up, so a message that must
  // not go out cannot be delayed behind — or excused by — a configuration problem.
  const allowed = await guardSend({ workspaceId: input.workspaceId, messageId: input.messageId })
  if (!allowed.ok) return err({ kind: 'rejected_by_guard', error: allowed.error })

  if (allowed.value.channel === 'email') {
    return err({ kind: 'channel_not_implemented', channel: 'email' })
  }

  const transport = wahaTransportFromEnv()
  if (!transport.ok) return err(transport.error)

  return sendMessageWith(input, { transport: transport.value })
}

/**
 * The same send with the transport supplied. Production calls `sendMessage`.
 *
 * The guard runs again here rather than being passed in from above. It costs one
 * query and it removes the only way this function could ever be handed a verdict
 * somebody else decided.
 */
export async function sendMessageWith(
  input: SendMessageInput,
  deps: SendDeps,
): Promise<Result<SendMessageSuccess, SendMessageError>> {
  const allowed = await guardSend({ workspaceId: input.workspaceId, messageId: input.messageId })
  if (!allowed.ok) return err({ kind: 'rejected_by_guard', error: allowed.error })

  const channel = allowed.value.channel
  if (channel === 'email') return err({ kind: 'channel_not_implemented', channel })

  const loaded = await attempt(() => loadOutbound(input.workspaceId, input.messageId))
  if (!loaded.ok) return err({ kind: 'load_failed', message: loaded.error })

  const message = loaded.value
  if (message === null) return err({ kind: 'message_not_found' })
  if (message.body === null || message.body.trim() === '') return err({ kind: 'empty_body' })
  if (message.leadId === null) return err({ kind: 'no_lead' })
  const leadId = message.leadId
  const text = message.body

  const account = await findWhatsAppAccount(input.workspaceId)
  if (!account.ok) {
    return account.error.kind === 'not_connected'
      ? err({ kind: 'not_connected', detail: account.error.detail })
      : err({ kind: 'load_failed', message: account.error.detail })
  }

  const claimed = await claim(input.workspaceId, input.messageId)
  if (!claimed.ok) return err(claimed.error)

  // From here on the row is claimed, so every failure has to say what became of the
  // message rather than throw. `sendMessageWith` is typed `Promise<Result<…>>` and
  // rule 9 means that is a promise, not a hint.
  const sent = await attempt(() =>
    deps.transport.send({
      account: account.value.session,
      to: allowed.value.recipient,
      text,
      idempotencyKey: input.idempotencyKey,
    }),
  )

  if (!sent.ok) {
    // The adapter threw instead of returning a rejection, so we do not know whether
    // WhatsApp got the message. The row stays `queued` — NOT `failed`, which would
    // invite a resend of something a customer may already have read. `send-context.ts`
    // bounds how long a queued row costs anything, so this heals without a resend.
    return err({ kind: 'outcome_unknown', providerMessageId: null, message: sent.error })
  }

  const outcome = sent.value
  if (!outcome.ok) {
    const failure = outcome.error
    const recorded = await attempt(() => recordFailure(input, leadId, deps.transport, failure))
    return err({ kind: 'send_failed', error: failure, recorded: recorded.ok })
  }

  const result = outcome.value
  const sentAt = new Date()
  const recorded = await attempt(() =>
    recordSuccess(input, {
      leadId,
      recipient: allowed.value.recipient,
      provider: deps.transport.provider,
      providerMessageId: result.providerMessageId,
      unparsedResponse: result.unparsedResponse,
      sentAt,
    }),
  )

  if (!recorded.ok) {
    // It WENT OUT and we could not write that down. Reported as its own kind, because
    // a caller must not read this as "not sent" and try again.
    return err({
      kind: 'outcome_unknown',
      providerMessageId: result.providerMessageId,
      message: recorded.error,
    })
  }

  return ok({
    messageId: input.messageId,
    channel,
    recipient: allowed.value.recipient,
    provider: deps.transport.provider,
    providerMessageId: result.providerMessageId,
    sentAt,
  })
}

/**
 * Runs something that may throw and hands back a `Result` carrying its message.
 *
 * Every database call below is behind this. A dropped connection between the
 * transport call and the status update used to escape a function typed
 * `Promise<Result<…>>` as an exception, which is both a rule 9 violation and the
 * exact moment a caller most needs a typed answer about a message that has already
 * reached a customer.
 */
async function attempt<T>(run: () => Promise<T>): Promise<Result<T, string>> {
  try {
    return ok(await run())
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

// -----------------------------------------------------------------------------
// The row
// -----------------------------------------------------------------------------

type Outbound = {
  readonly leadId: string | null
  readonly body: string | null
}

async function loadOutbound(workspaceId: string, messageId: string): Promise<Outbound | null> {
  const [row] = await db
    .select({ leadId: schema.messages.leadId, body: schema.messages.body })
    .from(schema.messages)
    // rule 6: the Drizzle handle bypasses RLS, so workspace_id is filtered here.
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.direction, 'out'),
      ),
    )
    .limit(1)

  return row ?? null
}

/**
 * Claims the message for this send, atomically.
 *
 * `approved` is the only status this moves from. The guard also accepts `queued`,
 * for the queue worker that does not exist yet; accepting it here would mean a
 * second call could pick up a message whose first send may already have reached
 * WhatsApp.
 *
 * It deliberately does not write `messages.idempotency_key`. That column belongs to
 * the step that created the draft and is protected by a unique index; a send
 * overwriting it would either lose the draft's key or collide with another row's,
 * and neither buys anything the claim above does not already guarantee. The send's
 * key is recorded in the activity row instead.
 */
async function claim(
  workspaceId: string,
  messageId: string,
): Promise<Result<null, SendMessageError>> {
  const outcome = await attempt(() => claimRow(workspaceId, messageId))
  if (!outcome.ok) return err({ kind: 'load_failed', message: outcome.error })
  return outcome.value
}

async function claimRow(
  workspaceId: string,
  messageId: string,
): Promise<Result<null, SendMessageError>> {
  const claimed = await db
    .update(schema.messages)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.direction, 'out'),
        eq(schema.messages.status, 'approved'),
      ),
    )
    .returning({ id: schema.messages.id })

  if (claimed[0] !== undefined) return ok(null)

  // Nothing claimed: report what it is now, so a caller can tell "already sent"
  // from "never approved" without a second guess.
  const [current] = await db
    .select({ status: schema.messages.status })
    .from(schema.messages)
    .where(
      and(eq(schema.messages.id, messageId), eq(schema.messages.workspaceId, workspaceId)),
    )
    .limit(1)

  if (current === undefined) return err({ kind: 'message_not_found' })
  return err({ kind: 'already_claimed', status: current.status })
}

// -----------------------------------------------------------------------------
// The audit trail (rule 10)
// -----------------------------------------------------------------------------

type SuccessRecord = {
  readonly leadId: string
  readonly recipient: string
  readonly provider: WhatsAppTransport['provider']
  readonly providerMessageId: string | null
  readonly unparsedResponse: { readonly status: number; readonly body: string } | null
  readonly sentAt: Date
}

async function recordSuccess(input: SendMessageInput, record: SuccessRecord): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({
        status: 'sent',
        providerMessageId: record.providerMessageId,
        sentAt: record.sentAt,
        // The conversation this belongs to. Inbound events write the same chat id,
        // which is what lets a reply land in the same thread as what it answers.
        threadId: toChatId(record.recipient),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.messages.id, input.messageId),
          eq(schema.messages.workspaceId, input.workspaceId),
        ),
      )

    await writeActivity(tx, {
      workspaceId: input.workspaceId,
      leadId: record.leadId,
      type: 'message_sent',
      // 'system', not 'human': a person approved the text, this row records the
      // machine that put it on the wire.
      actor: 'system',
      channel: 'whatsapp',
      payload: {
        messageId: input.messageId,
        provider: record.provider,
        recipient: record.recipient,
        providerMessageId: record.providerMessageId,
        idempotencyKey: input.idempotencyKey,
        // Only when the provider returned no id. Without it the row is frozen at
        // `sent` — no ack can ever match a null id — and this is the only record of
        // what the provider actually answered, so it is what a human reconciles
        // against. Absent on every ordinary send, which is most of them.
        ...(record.unparsedResponse === null
          ? {}
          : { unparsedResponse: record.unparsedResponse }),
      },
    })
  })
}

async function recordFailure(
  input: SendMessageInput,
  leadId: string,
  transport: WhatsAppTransport,
  error: WhatsAppSendError,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(
        and(
          eq(schema.messages.id, input.messageId),
          eq(schema.messages.workspaceId, input.workspaceId),
        ),
      )

    await writeActivity(tx, {
      workspaceId: input.workspaceId,
      leadId,
      type: 'message_failed',
      actor: 'system',
      channel: 'whatsapp',
      payload: {
        messageId: input.messageId,
        provider: transport.provider,
        idempotencyKey: input.idempotencyKey,
        error,
      },
    })
  })
}
