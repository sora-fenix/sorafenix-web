import { z } from 'zod'

import type { MessageStatus } from '@/lib/db/schema'
import { isMobilePhone, normalizePhone } from '@/lib/leads/normalize'
import { type Result, err, ok } from '@/lib/types/result'

/**
 * The WhatsApp transport seam, and WAHA as its first implementation (SPEC §6).
 *
 * Two providers are coming, not one. WAHA (a self-hosted WhatsApp Web bridge) is
 * what development and the first demos run on, because it needs no Meta business
 * verification; the Cloud API is what production will run on once that clears.
 * They differ in everything except the two things a sender cares about — "send this
 * text to this number" and "what id did the provider give it" — so that pair is the
 * interface and everything else is behind it. `send.ts` never names WAHA.
 *
 * This file is deliberately free of `server-only`, the database and `lib/env.ts`:
 * the chat-id format, the ack mapping and the session→workspace resolution are the
 * parts that are easy to get quietly wrong, and the unit suite has to be able to
 * import them with no environment at all. The same split as
 * `send-guard.ts` / `send-context.ts`. Credentials arrive as a config argument,
 * which is also what lets a test drive the real WAHA adapter against a fake fetch.
 *
 * Nothing here checks compliance. A transport that could decide to send would be a
 * bypass of `send-guard.ts` (CLAUDE.md rule 4); `send.ts` is the only caller, and
 * it asks the guard first.
 */

// -----------------------------------------------------------------------------
// The seam
// -----------------------------------------------------------------------------

export type WhatsAppSendRequest = {
  /**
   * The provider-side account this goes out from: a WAHA session name today, a
   * Cloud API phone number id later. Read from the workspace's `integrations` row,
   * never from the environment — one WAHA instance serves several sessions.
   */
  readonly account: string
  /** E.164, as `send-guard.ts` normalised it: `+628123456789`. */
  readonly to: string
  readonly text: string
  /**
   * CLAUDE.md rule 7. WAHA's `/api/sendText` has nowhere to put it, so for that
   * adapter it is carried only in our own audit trail; the Cloud API adapter will
   * pass it through. Row-level replay safety does not depend on the provider
   * honouring it — see the claim in `send.ts`.
   */
  readonly idempotencyKey: string
}

export type WhatsAppSendResult = {
  /**
   * Null when the provider accepted the message but we could not find an id in its
   * answer. Deliberately not an error: the message is already on its way, and reporting
   * a failure would invite a resend, which is a second message to a customer.
   *
   * What it costs is real, though, and worse than "correlating a later ack": acks are
   * matched on `provider_message_id`, so a null id NEVER matches one and the row is
   * frozen at `sent` for good. It can never reach `delivered`, and if the send actually
   * failed behind a 200 with an unreadable body, nothing downstream could ever discover
   * that. Hence `unparsedResponse`.
   */
  readonly providerMessageId: string | null
  /**
   * What the provider actually said, kept ONLY when no id could be read out of it. It
   * goes into the `message_sent` activity payload so a human has something to reconcile
   * the frozen row against. Null whenever `providerMessageId` is set.
   */
  readonly unparsedResponse: { readonly status: number; readonly body: string } | null
}

export type WhatsAppSendError =
  /** The provider was reachable and said no. Status included for the audit row. */
  | { readonly kind: 'rejected'; readonly status: number; readonly detail: string }
  /** Never reached the provider: DNS, connection refused, timeout. Retryable. */
  | { readonly kind: 'network'; readonly detail: string }

export type WhatsAppTransport = {
  /** Named in the activity payload so the trail says which bridge sent it. */
  readonly provider: 'waha' | 'cloud_api'
  readonly send: (
    request: WhatsAppSendRequest,
  ) => Promise<Result<WhatsAppSendResult, WhatsAppSendError>>
}

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

/** WAHA chat ids: `628123456789@c.us` for a person, `…@g.us` for a group. */
const CHAT_ID = /^(\d{6,20})@c\.us$/

/**
 * E.164 → WAHA chat id, or null when the number cannot receive WhatsApp.
 *
 * The `+` goes, the country code stays: `+628123456789` → `628123456789@c.us`.
 * Normalised first rather than string-sliced, so a number that reached us in any
 * of the shapes `normalizePhone` accepts produces the one chat id WAHA expects —
 * `08123…`, `62812…` and `+62 812 …` are the same conversation, and sending to two
 * spellings of it would be two messages to one person.
 */
export function toChatId(phone: string | null): string | null {
  const e164 = normalizePhone(phone)
  if (!isMobilePhone(e164) || e164 === null) return null
  return `${e164.slice(1)}@c.us`
}

/**
 * WAHA chat id → E.164, or null for anything that is not one person's number.
 *
 * A group id (`…@g.us`) returns null on purpose. A group is not a contact, and
 * attributing its traffic to whichever member's number appears in it would file a
 * stranger's message against a lead.
 */
export function fromChatId(chatId: string | null): string | null {
  if (chatId === null) return null

  const match = CHAT_ID.exec(chatId.trim())
  const digits = match?.[1]
  if (digits === undefined) return null

  return normalizePhone(`+${digits}`)
}

/**
 * True when WhatsApp is handing us back something we sent.
 *
 * Two signals, because neither is guaranteed: WAHA's own `fromMe` flag, and the
 * WhatsApp Web message id, which is `<fromMe>_<chatId>_<id>` — so a `true_` prefix
 * means the same thing without the flag.
 *
 * Used only for the `message` event. An ack is *about* our outbound message, so its id
 * legitimately starts with `true_`.
 */
export function isEcho(payload: {
  readonly id: string
  readonly fromMe?: boolean | undefined
}): boolean {
  return payload.fromMe === true || payload.id.startsWith('true_')
}

// -----------------------------------------------------------------------------
// Delivery acknowledgements
// -----------------------------------------------------------------------------

/**
 * WAHA's `ack` codes, from its `message.ack` payload.
 *
 * ERROR -1, PENDING 0, SERVER 1, DEVICE 2, READ 3, PLAYED 4. `PLAYED` only happens
 * for voice notes, which we never send, and is treated as READ.
 */
export function ackToStatus(ack: number): MessageStatus | null {
  if (ack === -1) return 'failed'
  if (ack === 1) return 'sent'
  if (ack === 2) return 'delivered'
  if (ack === 3 || ack === 4) return 'opened'
  // PENDING means the bridge has not done anything yet. Nothing to record.
  return null
}

/**
 * How far along a message is. An ack may only move it forward.
 *
 * WhatsApp acks arrive out of order often enough to matter — a `delivered` after a
 * `read` is normal — and a message that has already been `replied` to must not fall
 * back to `sent` because a late callback turned up. Statuses off this ladder
 * (`draft`, `rejected`, …) are not outbound delivery states and are absent
 * deliberately: an ack must never resurrect a message nobody approved.
 */
const DELIVERY_RANK: ReadonlyMap<MessageStatus, number> = new Map<MessageStatus, number>([
  ['queued', 0],
  ['sent', 1],
  ['delivered', 2],
  ['opened', 3],
  ['replied', 4],
])

/** The statuses an ack of `next` is allowed to overwrite. Empty means "none". */
export function statusesBelow(next: MessageStatus): readonly MessageStatus[] {
  // `failed` is not on the ladder: a provider error may land on any live outbound
  // status, and it is the one ack that is allowed to end a message's progress.
  if (next === 'failed') return ['queued', 'sent', 'delivered']

  const rank = DELIVERY_RANK.get(next)
  if (rank === undefined) return []

  return [...DELIVERY_RANK.entries()].flatMap(([status, at]) => (at < rank ? [status] : []))
}

// -----------------------------------------------------------------------------
// Which workspace an inbound event belongs to
// -----------------------------------------------------------------------------

export type SessionResolutionError =
  /** No workspace has registered this session. */
  | { readonly kind: 'unknown_session'; readonly session: string }
  /**
   * Two or more have. Migration 0018 makes this unreachable through
   * `connect-whatsapp.ts`, and it is still handled here, because the failure it
   * would cause is a tenant leak and "the index prevents it" is not something an
   * inbound handler should have to assume.
   */
  | { readonly kind: 'ambiguous_session'; readonly session: string; readonly count: number }

/**
 * The workspace that owns a WAHA session.
 *
 * THE SESSION IS THE TENANT KEY, AND THE PHONE NUMBER IS NEVER THE TENANT KEY.
 * One number can legitimately sit in two workspaces' `contacts` — an agency and its
 * client both selling to the same shop — so resolving a workspace from the sender
 * would hand whichever tenant matched first a message meant for the other. The
 * session is different: it is a credential the workspace owner connected, and
 * exactly one workspace holds it. Matching the sender against `contacts` happens
 * afterwards and only inside the workspace this returned.
 *
 * The lookup is injected so the resolver — and its two failure cases, the ones that
 * must never be guessed past — are unit-testable without Postgres.
 */
export async function resolveSessionWorkspace(
  session: string,
  lookup: (session: string) => Promise<readonly string[]>,
): Promise<Result<string, SessionResolutionError>> {
  const owners = await lookup(session)

  const first = owners[0]
  if (first === undefined) return err({ kind: 'unknown_session', session })
  if (owners.length > 1) {
    return err({ kind: 'ambiguous_session', session, count: owners.length })
  }

  return ok(first)
}

// -----------------------------------------------------------------------------
// WAHA
// -----------------------------------------------------------------------------

export type WahaConfig = {
  /** `http://localhost:3000` — no trailing path. */
  readonly baseUrl: string
  readonly apiKey: string
  /** Injected in tests. Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

/** Long enough for WAHA to hand the message to WhatsApp Web, short enough to fail a hung bridge. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * WAHA's answer to `POST /api/sendText`.
 *
 * `looseObject`, and everything optional, because the only field we want is the id
 * and the shape around it has changed between WAHA releases. The id itself comes
 * either as a string or as WhatsApp Web's own object with `_serialized` on it. A
 * body we cannot read is not a failed send (see `WhatsAppSendResult`), so this
 * schema is allowed to match almost anything — what it must not do is invent an id.
 */
const wahaSendResponseSchema = z.looseObject({
  id: z
    .union([
      z.string().min(1),
      z.looseObject({ _serialized: z.string().min(1) }).transform((value) => value._serialized),
    ])
    .nullish(),
})

/** Trimmed so a WAHA error page does not end up as a paragraph in an activity row. */
const MAX_DETAIL = 500

export function createWahaTransport(config: WahaConfig): WhatsAppTransport {
  const doFetch = config.fetch ?? globalThis.fetch
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/sendText`

  return {
    provider: 'waha',
    send: async (request) => {
      const chatId = toChatId(request.to)
      if (chatId === null) {
        // Unreachable through `send.ts`, which only ever passes what the guard
        // returned. Reported rather than thrown, because rule 9 does not care how
        // a caller got here.
        return err({
          kind: 'rejected',
          status: 0,
          detail: `not a WhatsApp-capable number: ${request.to}`,
        })
      }

      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // WAHA's own header name. Not Authorization.
            'x-api-key': config.apiKey,
          },
          body: JSON.stringify({
            session: request.account,
            chatId,
            text: request.text,
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })
      } catch (error: unknown) {
        return err({
          kind: 'network',
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      const body = await readBody(response)

      if (!response.ok) {
        return err({ kind: 'rejected', status: response.status, detail: body.slice(0, MAX_DETAIL) })
      }

      const providerMessageId = providerMessageIdFrom(body)
      return ok({
        providerMessageId,
        unparsedResponse:
          providerMessageId === null
            ? { status: response.status, body: body.slice(0, MAX_DETAIL) }
            : null,
      })
    },
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function providerMessageIdFrom(body: string): string | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }

  const parsed = wahaSendResponseSchema.safeParse(json)
  if (!parsed.success) return null

  return parsed.data.id ?? null
}
