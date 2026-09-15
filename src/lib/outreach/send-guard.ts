/**
 * The send guard (CLAUDE.md rule 4, `.claude/rules/outreach.md`).
 *
 * Every outbound message passes through `evaluateSend` before a provider adapter
 * is allowed to touch it. It checks, in this order and no other:
 *
 *   1. suppression   — opt-out list, and the contact's own opt-out
 *   2. daily_limit   — the workspace's per-channel daily cap
 *   3. cooldown      — at most one message per contact per 24h, across channels
 *   4. duplicate     — the same campaign message already went to this address
 *   5. approval      — a human approved it
 *   6. quiet_hours   — business hours in the LEAD's local time
 *
 * The order is the contract, not a style choice. When a message fails several
 * checks at once, the first failure is the reason reported, and the earliest
 * checks are the ones whose answer can never change by waiting: an opted-out
 * contact must be reported as opted out, not as "try again at 08:00".
 *
 * It never throws and it never sends. It returns a `Result`, and there is no
 * parameter, flag or mode that skips a check. If a caller needs to skip one, the
 * answer is no.
 *
 * This file is pure — no database, no clock, no `server-only` — so the unit suite
 * can walk every rejection path and its position in the order, which
 * `.claude/rules/testing.md` requires of this file by name. Loading the context
 * from Postgres lives in `send-context.ts`, the same split as `policy.ts` and
 * `agent.ts`: a file that imports the Drizzle handle cannot be imported by a test
 * that has no `DATABASE_URL`.
 *
 * `workspace.autonomous_mode` is deliberately not read anywhere here. It exists in
 * the schema and ships false, and `.claude/rules/ai.md` forbids wiring it to skip
 * approval in the MVP.
 */

import type { Message, MessageStatus } from '@/lib/db/schema'
import {
  isMobilePhone,
  normalizeCity,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from '@/lib/leads/normalize'
import { type Result, err, ok } from '@/lib/types/result'

// -----------------------------------------------------------------------------
// The contract
// -----------------------------------------------------------------------------

export type Channel = Message['channel']
export type Direction = Message['direction']

/** The six checks, in the order they run. The unit suite asserts this order. */
export const SEND_CHECKS = [
  'suppression',
  'daily_limit',
  'cooldown',
  'duplicate',
  'approval',
  'quiet_hours',
] as const

export type SendCheck = (typeof SEND_CHECKS)[number]

/**
 * Why a message may not go out.
 *
 * `no_recipient` is not one of the six. It is not a compliance judgement — it is
 * a message with nothing to send to — and it runs after them, so every one of
 * the six keeps its fixed position and a contact who opted out is still reported
 * as opted out even when their address is also missing.
 */
export type SendRejectionKind = SendCheck | 'no_recipient'

export type SendRejection = {
  readonly kind: SendRejectionKind
  /** Bahasa Indonesia. Shown in the approval queue next to the message. */
  readonly reason: string
  /**
   * When the same message could pass this check, or null when waiting cannot
   * help. A caller reschedules with `messages.scheduled_at`; it never retries a
   * null.
   */
  readonly retryAt: Date | null
}

export type SendAllowed = {
  readonly channel: Channel
  /** Normalised address: lowercased email, or E.164 WhatsApp number. */
  readonly recipient: string
  /** The zones whose business hours this send was checked against. */
  readonly timeZones: readonly string[]
}

export type RecipientFields = {
  readonly email: string | null
  readonly phone: string | null
  readonly whatsapp: string | null
}

/** One suppression row, as `send-context.ts` found it. */
export type SuppressionKey = {
  readonly kind: 'email' | 'phone' | 'domain'
  readonly value: string
}

/**
 * Everything the six checks are allowed to know. Every field is loaded from the
 * database by `send-context.ts`; nothing here is derived from a guess.
 */
export type SendContext = {
  readonly messageId: string
  readonly channel: Channel
  readonly direction: Direction
  readonly status: MessageStatus

  readonly recipient: RecipientFields
  /** `contacts.opt_out_at`. Set the moment an opt-out is seen. */
  readonly optOutAt: Date | null
  /** `companies.domain` — a domain suppression covers every channel. */
  readonly companyDomain: string | null
  /** Rows in `suppressions` matching any of `suppressionKeysFor(...)`. */
  readonly matchedSuppressions: readonly SuppressionKey[]

  /** Outbound messages on this channel already sent or queued today. */
  readonly sentToday: number
  /** `workspaces.daily_email_limit` or `daily_wa_limit`. */
  readonly dailyLimit: number
  /** When the workspace's current day ends, in its own timezone. */
  readonly dayEndsAt: Date

  /** The latest outbound message to this contact, on any channel. */
  readonly lastSentToContactAt: Date | null

  /** Another message of this campaign already sent or queued to this address. */
  readonly duplicateOfMessageId: string | null

  /** `companies.city` / `companies.country` — where the lead is, not where we are. */
  readonly city: string | null
  readonly country: string | null
}

// -----------------------------------------------------------------------------
// Tuning — every constant is asserted by the unit suite
// -----------------------------------------------------------------------------

/** SPEC §6: max one message per contact per 24h, across all channels. */
export const CONTACT_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Business hours in the lead's local time: 08:00 up to (not including) 17:00.
 *
 * Owner-confirmable assumption, 2026-09-15 — neither SPEC nor the rules name a
 * window. Minutes since local midnight, so a zone with a half-hour offset is not
 * rounded to the wrong hour.
 */
export const SENDING_START_MINUTE = 8 * 60
export const SENDING_END_MINUTE = 17 * 60

/** Monday to Friday. `Intl` weekday numbering: Sunday 0, Saturday 6. */
export const SENDING_WEEKDAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5])

/** Statuses a message may be sent from. Anything else was not approved, or already went. */
export const SENDABLE_STATUSES: ReadonlySet<MessageStatus> = new Set<MessageStatus>([
  'approved',
  'queued',
])

/** How far ahead `nextSendingWindow` looks before giving up. A long weekend fits. */
const WINDOW_SEARCH_DAYS = 8
const WINDOW_STEP_MS = 15 * 60 * 1000

// -----------------------------------------------------------------------------
// Where the lead is
// -----------------------------------------------------------------------------

const WIB = 'Asia/Jakarta'
const WITA = 'Asia/Makassar'
const WIT = 'Asia/Jayapura'

/** Every zone Indonesia spans, west to east. */
export const INDONESIA_TIME_ZONES: readonly string[] = [WIB, WITA, WIT]

/**
 * City → IANA zone, for the cities we can name with certainty.
 *
 * The six the lead hunter sweeps today, plus one anchor city per zone. This is not
 * meant to be a gazetteer: a city missing from it is not guessed at, it falls back
 * to "every zone Indonesia spans" (see `leadTimeZones`), which narrows the sending
 * window instead of risking a message at 06:00 in Jayapura. Add a city here when
 * the sweep reaches it.
 *
 * Keys are `normalizeCity` output, the same form dedupe compares.
 */
const CITY_TIME_ZONES: ReadonlyMap<string, string> = new Map([
  // Swept today — all Jawa Timur, all WIB.
  ['surabaya', WIB],
  ['sidoarjo', WIB],
  ['gresik', WIB],
  ['mojokerto', WIB],
  ['malang', WIB],
  ['batu', WIB],
  // One anchor per zone.
  ['jakarta', WIB],
  ['denpasar', WITA],
  ['makassar', WITA],
  ['jayapura', WIT],
])

/** `Kota Surabaya` and `Kabupaten Malang` are the same places as `Surabaya` and `Malang`. */
const ADMIN_PREFIX = /^(?:kota|kab|kabupaten)\s+/

/**
 * The zones whose business hours a send to this lead must respect.
 *
 * - A city we recognise → its one zone.
 * - An Indonesian lead in a city we do not recognise → **all three** zones, so the
 *   send has to be inside business hours everywhere it could plausibly be. That
 *   costs two hours of window. It never falls back to the workspace's timezone,
 *   which is exactly what `.claude/rules/outreach.md` rules out.
 * - Anything else → `null`, and `evaluateSend` refuses to send. We cannot tell 03:00
 *   from 10:00 for a lead whose location we do not know, and not sending is the only
 *   answer that cannot wake someone up.
 */
export function leadTimeZones(
  city: string | null,
  country: string | null,
): readonly string[] | null {
  const countryCode = country === null ? null : country.trim().toUpperCase()
  if (countryCode !== null && countryCode !== '' && countryCode !== 'ID') return null

  const cityKey = normalizeCity(city).replace(ADMIN_PREFIX, '')
  const zone = CITY_TIME_ZONES.get(cityKey)
  if (zone !== undefined) return [zone]

  if (countryCode === 'ID') return INDONESIA_TIME_ZONES
  return null
}

// -----------------------------------------------------------------------------
// When the lead is
// -----------------------------------------------------------------------------

const WEEKDAY_NUMBER: ReadonlyMap<string, number> = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
])

/** Built once per zone. Constructing an `Intl.DateTimeFormat` is the slow part. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    // h23, not hour12: false — the latter renders midnight as "24" in some
    // engines, which would put 00:30 at minute 1470 and outside every window.
    hourCycle: 'h23',
  })
  formatters.set(zone, created)
  return created
}

type LocalTime = { readonly weekday: number; readonly minute: number }

function localTime(zone: string, at: Date): LocalTime | null {
  let weekday: number | undefined
  let hour: number | undefined
  let minute: number | undefined

  for (const part of formatterFor(zone).formatToParts(at)) {
    if (part.type === 'weekday') weekday = WEEKDAY_NUMBER.get(part.value)
    if (part.type === 'hour') hour = Number(part.value)
    if (part.type === 'minute') minute = Number(part.value)
  }

  if (weekday === undefined || hour === undefined || minute === undefined) return null
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  return { weekday, minute: hour * 60 + minute }
}

/** True only when `at` falls inside business hours in EVERY one of `zones`. */
export function isWithinSendingHours(zones: readonly string[], at: Date): boolean {
  if (zones.length === 0) return false
  return zones.every((zone) => {
    const local = localTime(zone, at)
    if (local === null) return false
    return (
      SENDING_WEEKDAYS.has(local.weekday) &&
      local.minute >= SENDING_START_MINUTE &&
      local.minute < SENDING_END_MINUTE
    )
  })
}

/**
 * The first 15-minute boundary at or after `from` that is inside business hours
 * in every zone, or null if none exists within `WINDOW_SEARCH_DAYS`.
 *
 * A search rather than arithmetic, because "the next weekday 08:00 in three zones
 * at once" is the intersection of three calendars — easy to get subtly wrong by
 * hand across a weekend, and 768 cheap iterations to get right by brute force.
 */
export function nextSendingWindow(zones: readonly string[], from: Date): Date | null {
  if (zones.length === 0) return null

  const start = Math.ceil(from.getTime() / WINDOW_STEP_MS) * WINDOW_STEP_MS
  const steps = (WINDOW_SEARCH_DAYS * 24 * 60 * 60 * 1000) / WINDOW_STEP_MS

  for (let i = 0; i <= steps; i += 1) {
    const candidate = new Date(start + i * WINDOW_STEP_MS)
    if (isWithinSendingHours(zones, candidate)) return candidate
  }
  return null
}

// -----------------------------------------------------------------------------
// Who the message goes to
// -----------------------------------------------------------------------------

/**
 * The normalised address this channel would send to, or null.
 *
 * WhatsApp goes only to the `whatsapp` column, never to `phone`: ingest already
 * drops a landline from `whatsapp`, and a landline in `phone` cannot receive a
 * WhatsApp message at all.
 */
export function recipientFor(channel: Channel, recipient: RecipientFields): string | null {
  if (channel === 'email') return normalizeEmail(recipient.email)

  const whatsapp = normalizePhone(recipient.whatsapp)
  return isMobilePhone(whatsapp) ? whatsapp : null
}

/**
 * Every suppression key that should stop a message to this contact, on ANY channel.
 *
 * Deliberately not scoped to the channel being sent. `.claude/rules/outreach.md`:
 * a "STOP" on WhatsApp stops every sequence for that contact, not just the current
 * one — so a phone suppression blocks the email too, and a domain suppression
 * blocks the WhatsApp message to the company that asked.
 *
 * Normalised with the same functions ingest used, so a key built here matches the
 * row written there. Deduplicated, since phone and whatsapp are often one number.
 */
export function suppressionKeysFor(
  recipient: RecipientFields,
  companyDomain: string | null,
): readonly SuppressionKey[] {
  const keys: SuppressionKey[] = []
  const seen = new Set<string>()

  const add = (kind: SuppressionKey['kind'], value: string | null): void => {
    if (value === null) return
    const id = `${kind}:${value}`
    if (seen.has(id)) return
    seen.add(id)
    keys.push({ kind, value })
  }

  const email = normalizeEmail(recipient.email)
  add('email', email)
  add('phone', normalizePhone(recipient.phone))
  add('phone', normalizePhone(recipient.whatsapp))
  add('domain', normalizeDomain(companyDomain))
  add('domain', email === null ? null : normalizeDomain(email.slice(email.indexOf('@') + 1)))

  return keys
}

// -----------------------------------------------------------------------------
// The guard
// -----------------------------------------------------------------------------

type Check = (context: SendContext, now: Date) => SendRejection | null

const CHECKS: Readonly<Record<SendCheck, Check>> = {
  suppression: checkSuppression,
  daily_limit: checkDailyLimit,
  cooldown: checkCooldown,
  duplicate: checkDuplicate,
  approval: checkApproval,
  quiet_hours: checkQuietHours,
}

/**
 * The verdict on one message at one moment.
 *
 * `now` is a parameter, not `new Date()`, so a test can stand at 07:59 on a Friday
 * and a caller can ask "could this go at the scheduled time?" with the same code
 * that answers "can it go now?".
 */
export function evaluateSend(
  context: SendContext,
  now: Date,
): Result<SendAllowed, SendRejection> {
  // Iterating SEND_CHECKS, not the record, so the order has exactly one definition
  // and a reordering is a one-line diff the unit suite will notice.
  for (const check of SEND_CHECKS) {
    const rejection = CHECKS[check](context, now)
    if (rejection !== null) return err(rejection)
  }

  const recipient = recipientFor(context.channel, context.recipient)
  if (recipient === null) {
    return err({
      kind: 'no_recipient',
      reason:
        context.channel === 'email'
          ? 'Kontak ini belum punya alamat email yang valid.'
          : 'Kontak ini belum punya nomor WhatsApp yang valid.',
      retryAt: null,
    })
  }

  // checkQuietHours already refused a null here, so this cannot be null — but the
  // type does not know that, and narrowing it again costs less than a cast.
  const timeZones = leadTimeZones(context.city, context.country) ?? []

  return ok({ channel: context.channel, recipient, timeZones })
}

function checkSuppression(context: SendContext): SendRejection | null {
  if (context.optOutAt !== null) {
    return {
      kind: 'suppression',
      reason: 'Kontak ini sudah minta tidak dihubungi lagi.',
      retryAt: null,
    }
  }

  const match = context.matchedSuppressions[0]
  if (match !== undefined) {
    const what =
      match.kind === 'email' ? 'Alamat email' : match.kind === 'phone' ? 'Nomor' : 'Domain'
    return {
      kind: 'suppression',
      reason: `${what} ${match.value} ada di daftar jangan-hubungi.`,
      retryAt: null,
    }
  }

  return null
}

function checkDailyLimit(context: SendContext): SendRejection | null {
  if (context.sentToday < context.dailyLimit) return null

  const channel = context.channel === 'email' ? 'email' : 'WhatsApp'
  return {
    kind: 'daily_limit',
    reason: `Batas harian ${channel} workspace (${context.dailyLimit} pesan) sudah tercapai.`,
    retryAt: context.dayEndsAt,
  }
}

function checkCooldown(context: SendContext, now: Date): SendRejection | null {
  if (context.lastSentToContactAt === null) return null

  const clearsAt = new Date(context.lastSentToContactAt.getTime() + CONTACT_COOLDOWN_MS)
  if (now.getTime() >= clearsAt.getTime()) return null

  return {
    kind: 'cooldown',
    reason: 'Kontak ini sudah dikirimi pesan dalam 24 jam terakhir.',
    retryAt: clearsAt,
  }
}

function checkDuplicate(context: SendContext): SendRejection | null {
  if (context.duplicateOfMessageId === null) return null
  return {
    kind: 'duplicate',
    reason: 'Pesan kampanye yang sama sudah dikirim ke alamat ini.',
    retryAt: null,
  }
}

function checkApproval(context: SendContext): SendRejection | null {
  if (context.direction !== 'out') {
    return {
      kind: 'approval',
      reason: 'Ini pesan masuk, tidak bisa dikirim.',
      retryAt: null,
    }
  }

  if (SENDABLE_STATUSES.has(context.status)) return null

  return {
    kind: 'approval',
    reason: approvalReason(context.status),
    retryAt: null,
  }
}

function approvalReason(status: MessageStatus): string {
  switch (status) {
    case 'draft':
      return 'Pesan masih draf dan belum diajukan untuk persetujuan.'
    case 'needs_input':
      return 'Pesan masih ada bagian kosong yang harus diisi dulu.'
    case 'pending_approval':
      return 'Pesan belum disetujui.'
    case 'rejected':
      return 'Pesan ini sudah ditolak.'
    default:
      return 'Pesan ini sudah pernah diproses dan tidak bisa dikirim ulang.'
  }
}

function checkQuietHours(context: SendContext, now: Date): SendRejection | null {
  const zones = leadTimeZones(context.city, context.country)

  if (zones === null) {
    return {
      kind: 'quiet_hours',
      reason: 'Zona waktu lead tidak diketahui, jadi jam kirim yang aman tidak bisa dipastikan.',
      retryAt: null,
    }
  }

  if (isWithinSendingHours(zones, now)) return null

  return {
    kind: 'quiet_hours',
    reason: 'Di luar jam kerja (08.00–17.00, Senin–Jumat) di tempat lead.',
    retryAt: nextSendingWindow(zones, now),
  }
}
