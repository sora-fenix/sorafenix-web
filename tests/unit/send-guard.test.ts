import { describe, expect, it } from 'vitest'

import type { MessageStatus } from '@/lib/db/schema'
import {
  CONTACT_COOLDOWN_MS,
  INDONESIA_TIME_ZONES,
  SEND_CHECKS,
  type SendContext,
  type SendRejectionKind,
  evaluateSend,
  isWithinSendingHours,
  leadTimeZones,
  nextSendingWindow,
  recipientFor,
  suppressionKeysFor,
} from '@/lib/outreach/send-guard'

/**
 * The send guard is the last thing between an approved draft and a real person's
 * phone. `.claude/rules/testing.md` names this file, and asks for the rejection
 * paths one by one *including their order* — so the order block below is the one
 * that matters most: it proves an opted-out contact is reported as opted out, not
 * as "try again at 08:00".
 *
 * Times are fixed instants, never `new Date()`. 2026-09-14 is a Monday.
 */

/** Monday 10:00 WIB · 11:00 WITA · 12:00 WIT — inside business hours everywhere. */
const MON_10_WIB = new Date('2026-09-14T03:00:00Z')

const WA = '+6281234567890'

/** A message every check passes. Each test breaks exactly the thing it is about. */
const PASSING: SendContext = {
  messageId: 'msg-1',
  channel: 'whatsapp',
  direction: 'out',
  status: 'approved',
  recipient: { email: null, phone: WA, whatsapp: WA },
  optOutAt: null,
  companyDomain: null,
  matchedSuppressions: [],
  sentToday: 0,
  dailyLimit: 100,
  dayEndsAt: new Date('2026-09-14T17:00:00Z'),
  lastSentToContactAt: null,
  duplicateOfMessageId: null,
  city: 'Surabaya',
  country: 'ID',
}

function context(overrides: Partial<SendContext>): SendContext {
  return { ...PASSING, ...overrides }
}

function rejection(ctx: SendContext, now: Date = MON_10_WIB) {
  const result = evaluateSend(ctx, now)
  if (result.ok) throw new Error('expected a rejection, the guard allowed the send')
  return result.error
}

function kindOf(ctx: SendContext, now: Date = MON_10_WIB): SendRejectionKind | 'allowed' {
  const result = evaluateSend(ctx, now)
  return result.ok ? 'allowed' : result.error.kind
}

// -----------------------------------------------------------------------------

describe('a compliant message', () => {
  it('is allowed, with the address it goes to and the zones it was checked in', () => {
    const result = evaluateSend(PASSING, MON_10_WIB)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.recipient).toBe(WA)
    expect(result.value.channel).toBe('whatsapp')
    expect(result.value.timeZones).toEqual(['Asia/Jakarta'])
  })

  it('is judged the same way twice and never mutated', () => {
    const frozen = Object.freeze({ ...PASSING })
    expect(evaluateSend(frozen, MON_10_WIB)).toEqual(evaluateSend(frozen, MON_10_WIB))
  })
})

describe('the order of the checks', () => {
  it('is exactly the order .claude/rules/outreach.md lists', () => {
    expect([...SEND_CHECKS]).toEqual([
      'suppression',
      'daily_limit',
      'cooldown',
      'duplicate',
      'approval',
      'quiet_hours',
    ])
  })

  it('reports the earliest failure when a message fails every check at once', () => {
    // Break all six, plus the address, then repair them front to back. Each repair
    // must reveal exactly the next check in the list — which is only true if the
    // guard evaluates them in that order and stops at the first failure.
    const SUNDAY_03_WIB = new Date('2026-09-19T20:00:00Z')
    const repairs: Partial<SendContext>[] = [
      { optOutAt: null },
      { sentToday: 0 },
      { lastSentToContactAt: null },
      { duplicateOfMessageId: null },
      { status: 'approved' },
      {},
    ]

    let ctx = context({
      optOutAt: new Date('2026-09-01T00:00:00Z'),
      sentToday: 100,
      lastSentToContactAt: new Date('2026-09-19T19:00:00Z'),
      duplicateOfMessageId: 'msg-0',
      status: 'pending_approval',
      recipient: { email: null, phone: null, whatsapp: null },
    })

    const seen: string[] = []
    for (const repair of repairs) {
      seen.push(kindOf(ctx, SUNDAY_03_WIB))
      ctx = { ...ctx, ...repair }
    }

    expect(seen).toEqual([...SEND_CHECKS])
    // With the six repaired, it still refuses — at Sunday 03:00, and then for the
    // missing address once the clock is moved into business hours.
    expect(kindOf(ctx, MON_10_WIB)).toBe('no_recipient')
  })

  it('reports an opted-out contact as opted out, even at 03:00 on a Sunday', () => {
    const SUNDAY_03_WIB = new Date('2026-09-19T20:00:00Z')
    const opted = context({ optOutAt: new Date('2026-09-01T00:00:00Z') })
    const verdict = rejection(opted, SUNDAY_03_WIB)
    expect(verdict.kind).toBe('suppression')
    expect(verdict.retryAt).toBeNull()
  })

  it('checks the address only after all six, so no_recipient never hides a compliance reason', () => {
    const optedAndEmpty = context({
      optOutAt: new Date('2026-09-01T00:00:00Z'),
      recipient: { email: null, phone: null, whatsapp: null },
    })
    expect(kindOf(optedAndEmpty)).toBe('suppression')
  })
})

describe('1 · suppression', () => {
  it("refuses a contact who opted out, and waiting never helps", () => {
    const verdict = rejection(context({ optOutAt: new Date('2026-09-01T00:00:00Z') }))
    expect(verdict.kind).toBe('suppression')
    expect(verdict.retryAt).toBeNull()
    expect(verdict.reason).toContain('tidak dihubungi')
  })

  it.each([
    ['email', 'budi@tokohewan.co.id', 'Alamat email'],
    ['phone', WA, 'Nomor'],
    ['domain', 'tokohewan.co.id', 'Domain'],
  ] as const)('refuses on a matched %s suppression', (kind, value, label) => {
    const verdict = rejection(context({ matchedSuppressions: [{ kind, value }] }))
    expect(verdict.kind).toBe('suppression')
    expect(verdict.reason).toContain(label)
    expect(verdict.reason).toContain(value)
    expect(verdict.retryAt).toBeNull()
  })

  it('passes a contact with no opt-out and no matching row', () => {
    expect(kindOf(PASSING)).toBe('allowed')
  })
})

describe('suppression keys', () => {
  it('covers every identifier of the contact, not only the channel being sent', () => {
    // A STOP on WhatsApp must also stop the email. So an email send still looks
    // the phone number up, and a WhatsApp send still looks the domain up.
    const keys = suppressionKeysFor(
      { email: 'Budi@TokoHewan.co.id', phone: '0812-3456-7890', whatsapp: null },
      'https://www.tokohewan.co.id/kontak',
    )
    expect(keys).toEqual([
      { kind: 'email', value: 'budi@tokohewan.co.id' },
      { kind: 'phone', value: WA },
      { kind: 'domain', value: 'tokohewan.co.id' },
    ])
  })

  it('normalises exactly the way ingest does, so a stored row actually matches', () => {
    const keys = suppressionKeysFor({ email: null, phone: '+62 812 3456 7890', whatsapp: null }, null)
    expect(keys).toEqual([{ kind: 'phone', value: WA }])
  })

  it('lists one number once when phone and WhatsApp are the same', () => {
    const keys = suppressionKeysFor({ email: null, phone: WA, whatsapp: '081234567890' }, null)
    expect(keys.filter((key) => key.kind === 'phone')).toHaveLength(1)
  })

  it('also checks the email address domain when the company has none recorded', () => {
    const keys = suppressionKeysFor({ email: 'info@petmart.id', phone: null, whatsapp: null }, null)
    expect(keys).toContainEqual({ kind: 'domain', value: 'petmart.id' })
  })

  it('yields nothing for a contact with nothing on file', () => {
    expect(suppressionKeysFor({ email: null, phone: null, whatsapp: null }, null)).toEqual([])
  })
})

describe('2 · daily_limit', () => {
  it('refuses at the limit and says when the day resets', () => {
    const dayEndsAt = new Date('2026-09-14T17:00:00Z')
    const verdict = rejection(context({ sentToday: 100, dailyLimit: 100, dayEndsAt }))
    expect(verdict.kind).toBe('daily_limit')
    expect(verdict.retryAt).toEqual(dayEndsAt)
    expect(verdict.reason).toContain('100')
  })

  it('passes one below the limit', () => {
    expect(kindOf(context({ sentToday: 99, dailyLimit: 100 }))).toBe('allowed')
  })

  it('treats a limit of zero as "send nothing"', () => {
    expect(kindOf(context({ sentToday: 0, dailyLimit: 0 }))).toBe('daily_limit')
  })

  it('names the channel in the reason', () => {
    expect(rejection(context({ sentToday: 5, dailyLimit: 5 })).reason).toContain('WhatsApp')
  })
})

describe('3 · cooldown', () => {
  it('refuses a second message inside 24 hours, and says when it clears', () => {
    const last = new Date(MON_10_WIB.getTime() - CONTACT_COOLDOWN_MS + 60_000)
    const verdict = rejection(context({ lastSentToContactAt: last }))
    expect(verdict.kind).toBe('cooldown')
    expect(verdict.retryAt).toEqual(new Date(last.getTime() + CONTACT_COOLDOWN_MS))
  })

  it('passes at exactly 24 hours', () => {
    const last = new Date(MON_10_WIB.getTime() - CONTACT_COOLDOWN_MS)
    expect(kindOf(context({ lastSentToContactAt: last }))).toBe('allowed')
  })

  it('is 24 hours, per SPEC §6', () => {
    expect(CONTACT_COOLDOWN_MS).toBe(86_400_000)
  })
})

describe('4 · duplicate', () => {
  it('refuses the same campaign message to the same address, permanently', () => {
    const verdict = rejection(context({ duplicateOfMessageId: 'msg-0' }))
    expect(verdict.kind).toBe('duplicate')
    expect(verdict.retryAt).toBeNull()
  })
})

describe('5 · approval', () => {
  const sendable: MessageStatus[] = ['approved', 'queued']
  const notSendable: MessageStatus[] = [
    'draft',
    'needs_input',
    'pending_approval',
    'rejected',
    'sent',
    'delivered',
    'opened',
    'replied',
    'bounced',
    'failed',
  ]

  it.each(sendable)('passes a %s message', (status) => {
    expect(kindOf(context({ status }))).toBe('allowed')
  })

  it.each(notSendable)('refuses a %s message', (status) => {
    const verdict = rejection(context({ status }))
    expect(verdict.kind).toBe('approval')
    expect(verdict.retryAt).toBeNull()
  })

  it('covers every status in the enum exactly once between the two lists', () => {
    // A status added to the enum later must be decided on, not silently refused or
    // silently allowed by whichever list it was forgotten from.
    expect(sendable.length + notSendable.length).toBe(12)
    expect(new Set([...sendable, ...notSendable]).size).toBe(12)
  })

  it('explains needs_input as a gap to fill, not a rejection', () => {
    expect(rejection(context({ status: 'needs_input' })).reason).toContain('diisi')
  })

  it('refuses an inbound message outright', () => {
    const verdict = rejection(context({ direction: 'in' }))
    expect(verdict.kind).toBe('approval')
    expect(verdict.reason).toContain('masuk')
  })
})

describe('6 · quiet_hours', () => {
  it('passes at 08:00 sharp and at 16:59 local', () => {
    expect(kindOf(PASSING, new Date('2026-09-14T01:00:00Z'))).toBe('allowed')
    expect(kindOf(PASSING, new Date('2026-09-14T09:59:00Z'))).toBe('allowed')
  })

  it('refuses at 07:59 and points at 08:00 the same morning', () => {
    const verdict = rejection(PASSING, new Date('2026-09-14T00:59:00Z'))
    expect(verdict.kind).toBe('quiet_hours')
    expect(verdict.retryAt).toEqual(new Date('2026-09-14T01:00:00Z'))
  })

  it('refuses at 17:00 on a Friday and points at 08:00 on Monday', () => {
    const verdict = rejection(PASSING, new Date('2026-09-18T10:00:00Z'))
    expect(verdict.kind).toBe('quiet_hours')
    expect(verdict.retryAt).toEqual(new Date('2026-09-21T01:00:00Z'))
  })

  it.each([
    ['Saturday', '2026-09-19T03:00:00Z'],
    ['Sunday', '2026-09-20T03:00:00Z'],
  ])('refuses %s even at 10:00', (_day, iso) => {
    expect(kindOf(PASSING, new Date(iso))).toBe('quiet_hours')
  })

  it("uses the LEAD's time, not the workspace's", () => {
    // 07:30 in Jakarta is 09:30 in Jayapura. A Jayapura lead is inside its hours;
    // a Surabaya lead is not. A guard reading the workspace's WIB would get the
    // first one wrong.
    const at = new Date('2026-09-14T00:30:00Z')
    expect(kindOf(context({ city: 'Jayapura' }), at)).toBe('allowed')
    expect(kindOf(context({ city: 'Surabaya' }), at)).toBe('quiet_hours')
  })

  it('narrows to the window every Indonesian zone shares when the city is unknown', () => {
    // 08:00–17:00 in all of WIB, WITA and WIT at once is 08:00–15:00 WIB.
    const unknownCity = context({ city: 'Kecamatan Antah Berantah' })
    expect(kindOf(unknownCity, new Date('2026-09-14T01:00:00Z'))).toBe('allowed') // 08:00 WIB
    expect(kindOf(unknownCity, new Date('2026-09-14T07:59:00Z'))).toBe('allowed') // 14:59 WIB
    const late = rejection(unknownCity, new Date('2026-09-14T08:00:00Z')) // 15:00 WIB = 17:00 WIT
    expect(late.kind).toBe('quiet_hours')
    expect(late.retryAt).toEqual(new Date('2026-09-15T01:00:00Z'))
  })

  it('refuses outright when the lead is outside a country it can place', () => {
    const verdict = rejection(context({ city: 'Singapore', country: 'SG' }))
    expect(verdict.kind).toBe('quiet_hours')
    expect(verdict.retryAt).toBeNull()
    expect(verdict.reason).toContain('tidak diketahui')
  })
})

describe('where the lead is', () => {
  it.each([
    ['Surabaya', 'Asia/Jakarta'],
    ['Sidoarjo', 'Asia/Jakarta'],
    ['Gresik', 'Asia/Jakarta'],
    ['Mojokerto', 'Asia/Jakarta'],
    ['Malang', 'Asia/Jakarta'],
    ['Batu', 'Asia/Jakarta'],
    ['Denpasar', 'Asia/Makassar'],
    ['Makassar', 'Asia/Makassar'],
    ['Jayapura', 'Asia/Jayapura'],
  ])('places %s in %s', (city, zone) => {
    expect(leadTimeZones(city, 'ID')).toEqual([zone])
  })

  it('reads through administrative prefixes and case', () => {
    expect(leadTimeZones('Kota Surabaya', 'ID')).toEqual(['Asia/Jakarta'])
    expect(leadTimeZones('Kab. Malang', 'id')).toEqual(['Asia/Jakarta'])
    expect(leadTimeZones('  SIDOARJO ', 'ID')).toEqual(['Asia/Jakarta'])
  })

  it('falls back to all three zones for an Indonesian city it does not know', () => {
    expect(leadTimeZones('Pontianak', 'ID')).toEqual(INDONESIA_TIME_ZONES)
    expect(leadTimeZones(null, 'ID')).toEqual(INDONESIA_TIME_ZONES)
  })

  it('never falls back to the workspace timezone', () => {
    expect(leadTimeZones('Kuala Lumpur', 'MY')).toBeNull()
    expect(leadTimeZones('Pontianak', null)).toBeNull()
  })

  it('still places a known city when the country column is empty', () => {
    expect(leadTimeZones('Surabaya', null)).toEqual(['Asia/Jakarta'])
  })
})

describe('the sending window', () => {
  it('requires every zone to be open', () => {
    const at = new Date('2026-09-14T08:30:00Z') // 15:30 WIB · 17:30 WIT
    expect(isWithinSendingHours(['Asia/Jakarta'], at)).toBe(true)
    expect(isWithinSendingHours(['Asia/Jakarta', 'Asia/Jayapura'], at)).toBe(false)
  })

  it('is closed for an empty zone list rather than vacuously open', () => {
    expect(isWithinSendingHours([], MON_10_WIB)).toBe(false)
    expect(nextSendingWindow([], MON_10_WIB)).toBeNull()
  })

  it('returns the current instant when already open on a boundary', () => {
    expect(nextSendingWindow(['Asia/Jakarta'], MON_10_WIB)).toEqual(MON_10_WIB)
  })

  it('reads 00:30 as the start of the day, not the end of it', () => {
    // Guards the hourCycle choice: some engines render midnight as "24" under
    // hour12: false, which would place 00:30 at minute 1470.
    const halfPastMidnight = new Date('2026-09-13T17:30:00Z') // Mon 00:30 WIB
    expect(isWithinSendingHours(['Asia/Jakarta'], halfPastMidnight)).toBe(false)
    expect(nextSendingWindow(['Asia/Jakarta'], halfPastMidnight)).toEqual(
      new Date('2026-09-14T01:00:00Z'),
    )
  })
})

describe('no_recipient', () => {
  it('refuses an email with no email address', () => {
    const verdict = rejection(context({ channel: 'email' }))
    expect(verdict.kind).toBe('no_recipient')
    expect(verdict.reason).toContain('email')
  })

  it('refuses WhatsApp to a landline — it cannot receive one', () => {
    const verdict = rejection(
      context({ recipient: { email: null, phone: '+62315551234', whatsapp: '+62315551234' } }),
    )
    expect(verdict.kind).toBe('no_recipient')
    expect(verdict.reason).toContain('WhatsApp')
  })

  it('never falls back from WhatsApp to the phone column', () => {
    expect(recipientFor('whatsapp', { email: null, phone: WA, whatsapp: null })).toBeNull()
  })

  it('sends email to the normalised address', () => {
    expect(
      recipientFor('email', { email: '  Budi@TokoHewan.co.id ', phone: null, whatsapp: null }),
    ).toBe('budi@tokohewan.co.id')
  })
})
