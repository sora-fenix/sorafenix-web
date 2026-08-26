import { describe, expect, it } from 'vitest'

import {
  type CompanyLookup,
  type MatchStrategy,
  type NormalizedLead,
  type RawLead,
  dedupeKeyFor,
  findDuplicate,
  isContactable,
  normalizeLead,
} from '@/lib/leads/dedupe'
import {
  isMobilePhone,
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from '@/lib/leads/normalize'

// -----------------------------------------------------------------------------
// Phone — the field that decides whether dedupe works at all
// -----------------------------------------------------------------------------

describe('normalizePhone', () => {
  // Every form below was taken from a real Indonesian business listing or
  // website footer. `expected` null means "this is not a phone number".
  const cases: ReadonlyArray<readonly [label: string, input: string, expected: string | null]> =
    [
      // --- the four forms SPEC §2 names explicitly ---
      ['08xx mobile', '081234567890', '+6281234567890'],
      ['8xx without trunk prefix', '81234567890', '+6281234567890'],
      ['62xx without plus', '6281234567890', '+6281234567890'],
      ['+62xx canonical', '+6281234567890', '+6281234567890'],

      // --- separators: the reason a naive regex misses most footers ---
      ['spaces', '+62 812 3456 7890', '+6281234567890'],
      ['dashes', '0812-3456-7890', '+6281234567890'],
      ['dots', '0812.3456.7890', '+6281234567890'],
      ['mixed separators', '+62 812-3456.7890', '+6281234567890'],
      ['en dash', '0812–3456–7890', '+6281234567890'],
      ['non-breaking space', '+62 812 3456 7890', '+6281234567890'],
      ['leading and trailing space', '  081234567890  ', '+6281234567890'],

      // --- the hostile ones ---
      ['trunk prefix inside country code', '+62 (0) 812 3456 7890', '+6281234567890'],
      ['doubled country code', '+6262812345678', '+62812345678'],
      ['international access prefix', '0062 812 3456 7890', '+6281234567890'],
      ['parenthesised area code', '(021) 555-1234', '+62215551234'],
      ['extension is dropped', '021 5551234 ext 12', '+62215551234'],
      ['label after the number', '081234567890 (WhatsApp)', '+6281234567890'],
      ['price, not a phone', 'Rp 62.000.000', null],
      ['small price starting 62', '62.000', null],
      ['plain number starting with 1', '1500000', null],
      ['year range', '2019-2024', null],
      ['too short', '08123', null],
      ['too long', '081234567890123456', null],
      ['digits stripped to nothing', '-', null],
      ['letters only', 'hubungi kami', null],
      ['an email is not a phone', 'info@toko.co.id', null],
      ['empty', '', null],
      ['whitespace only', '   ', null],
      ['zero', '0', null],
      ['bare country code', '+62', null],
      ['country code plus one digit', '+628', null],
      ['full-width digits are not accepted', '０８１２３４５６７８９０', null],

      // --- landlines: Google Maps returns these constantly ---
      ['Jakarta landline', '021-5551234', '+62215551234'],
      ['Surabaya landline', '+62 31 8765432', '+62318765432'],
      ['Yogyakarta three-digit area code', '0274-123456', '+62274123456'],
      ['Bandung landline with spaces', '022 4567890', '+62224567890'],
    ]

  for (const [label, input, expected] of cases) {
    it(`${label}: ${JSON.stringify(input)} → ${expected ?? 'null'}`, () => {
      expect(normalizePhone(input)).toBe(expected)
    })
  }

  it('treats null and undefined as absent, not as an error', () => {
    expect(normalizePhone(null)).toBeNull()
    expect(normalizePhone(undefined)).toBeNull()
  })

  it('collapses every spelling of one number to a single value', () => {
    const spellings = [
      '081234567890',
      '81234567890',
      '6281234567890',
      '+6281234567890',
      '+62 812 3456 7890',
      '0812-3456-7890',
      '+62 (0) 812 3456 7890',
      '0062 812 3456 7890',
    ]
    const normalized = new Set(spellings.map((s) => normalizePhone(s)))
    expect(normalized).toEqual(new Set(['+6281234567890']))
  })

  it('separates mobile from landline', () => {
    expect(isMobilePhone(normalizePhone('081234567890'))).toBe(true)
    expect(isMobilePhone(normalizePhone('021-5551234'))).toBe(false)
    expect(isMobilePhone(null)).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Domain
// -----------------------------------------------------------------------------

describe('normalizeDomain', () => {
  const cases: ReadonlyArray<readonly [input: string, expected: string | null]> = [
    ['https://www.PetShop.co.id/kontak?a=1', 'petshop.co.id'],
    ['HTTP://PETSHOP.CO.ID', 'petshop.co.id'],
    ['petshopsby.com', 'petshopsby.com'],
    ['www.toko.id/', 'toko.id'],
    ['https://user:pass@toko.co.id:8443/x', 'toko.co.id'],
    ['toko.co.id.', 'toko.co.id'],
    ['https://sub.domain.toko.co.id', 'sub.domain.toko.co.id'],
    ['  https://toko.id  ', 'toko.id'],
    // Not domains.
    ['192.168.1.1', null],
    ['localhost', null],
    ['toko', null],
    ['', null],
    ['   ', null],
    ['https://', null],
  ]

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected ?? 'null'}`, () => {
      expect(normalizeDomain(input)).toBe(expected)
    })
  }

  // If this ever regresses, every website-less company in a batch collapses into
  // one row, because they all share the scraper's placeholder.
  it('rejects reserved placeholder domains so sentinels cannot merge companies', () => {
    expect(normalizeDomain('https://no-website.invalid')).toBeNull()
    expect(normalizeDomain('example.com')).toBeNull()
    expect(normalizeDomain('foo.test')).toBeNull()
    expect(normalizeDomain('shop.example')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

describe('normalizeEmail', () => {
  const cases: ReadonlyArray<readonly [input: string, expected: string | null]> = [
    ['  INFO@Toko.CO.ID ', 'info@toko.co.id'],
    ['mailto:sales@toko.id', 'sales@toko.id'],
    ['(cs@toko.id)', 'cs@toko.id'],
    ['<admin@toko.id>', 'admin@toko.id'],
    ['info@toko.co.id.', 'info@toko.co.id'],
    ['halo+promo@toko.id', 'halo+promo@toko.id'],
    ['not-an-email', null],
    ['a@b', null],
    ['a@@b.com', null],
    ['@toko.id', null],
    ['', null],
  ]

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected ?? 'null'}`, () => {
      expect(normalizeEmail(input)).toBe(expected)
    })
  }
})

// -----------------------------------------------------------------------------
// Company name
// -----------------------------------------------------------------------------

describe('normalizeCompanyName', () => {
  it('strips the legal form so the trading name is what gets compared', () => {
    expect(normalizeCompanyName('PT Maju Bersama Digital')).toBe('maju bersama digital')
    expect(normalizeCompanyName('CV. Anugerah Mandiri')).toBe('anugerah mandiri')
    expect(normalizeCompanyName('UD Sumber Rejeki')).toBe('sumber rejeki')
  })

  it('collapses punctuation and spacing', () => {
    expect(normalizeCompanyName('  Toko   Hewan  "Bahagia"! ')).toBe('toko hewan bahagia')
  })

  it('returns an empty string when nothing identifying is left', () => {
    expect(normalizeCompanyName('')).toBe('')
    expect(normalizeCompanyName('   ')).toBe('')
    expect(normalizeCompanyName(null)).toBe('')
  })
})

// -----------------------------------------------------------------------------
// The reject rule
// -----------------------------------------------------------------------------

function lead(overrides: Partial<RawLead> = {}): NormalizedLead {
  return normalizeLead({ companyName: 'Pet Shop Surabaya', ...overrides })
}

describe('isContactable', () => {
  it('keeps an item with any one channel', () => {
    expect(isContactable(lead({ website: 'https://petshopsby.com' }))).toBe(true)
    expect(isContactable(lead({ phone: '081234567890' }))).toBe(true)
    expect(isContactable(lead({ email: 'info@petshopsby.com' }))).toBe(true)
  })

  it('rejects an item with no channel at all', () => {
    expect(isContactable(lead())).toBe(false)
  })

  // The whole point of checking normalised values: these look filled in.
  it('rejects placeholder values that survive a trimmed-string check', () => {
    expect(isContactable(lead({ phone: '-', email: 'n/a', website: '   ' }))).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// dedupe_key
// -----------------------------------------------------------------------------

describe('dedupeKeyFor', () => {
  it('prefers the strongest identifier available', () => {
    expect(
      dedupeKeyFor(
        lead({ website: 'https://petshopsby.com', phone: '081234567890', email: 'a@b.co' }),
      ),
    ).toBe('domain:petshopsby.com')
    expect(dedupeKeyFor(lead({ phone: '081234567890', email: 'a@b.co' }))).toBe(
      'phone:+6281234567890',
    )
    expect(dedupeKeyFor(lead({ email: 'a@b.co' }))).toBe('email:a@b.co')
    expect(dedupeKeyFor(lead())).toBe('name:pet shop surabaya')
  })

  it('is null when the item carries nothing identifying', () => {
    expect(dedupeKeyFor(normalizeLead({ companyName: '   ' }))).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Strategy order — the part that must never be reshuffled
// -----------------------------------------------------------------------------

type LookupTables = {
  domain?: Record<string, string>
  phone?: Record<string, string>
  email?: Record<string, string>
  fuzzy?: Record<string, string>
}

/** Records which strategies were consulted, so short-circuiting is observable. */
function fakeLookup(tables: LookupTables): CompanyLookup & { calls: MatchStrategy[] } {
  const calls: MatchStrategy[] = []
  return {
    calls,
    byDomain: (domain) => {
      calls.push('domain')
      return Promise.resolve(tables.domain?.[domain] ?? null)
    },
    byPhone: (phone) => {
      calls.push('phone')
      return Promise.resolve(tables.phone?.[phone] ?? null)
    },
    byEmail: (email) => {
      calls.push('email')
      return Promise.resolve(tables.email?.[email] ?? null)
    },
    byFuzzyNameCity: (name, city) => {
      calls.push('fuzzy_name_city')
      return Promise.resolve(tables.fuzzy?.[`${name}|${city}`] ?? null)
    },
  }
}

describe('findDuplicate', () => {
  const full: RawLead = {
    companyName: 'PT Pet Shop Surabaya',
    website: 'https://petshopsby.com',
    city: 'Surabaya',
    phone: '081234567890',
    email: 'info@petshopsby.com',
  }

  it('matches on domain first, even when other identifiers point elsewhere', async () => {
    const lookup = fakeLookup({
      domain: { 'petshopsby.com': 'company-domain' },
      phone: { '+6281234567890': 'company-phone' },
      email: { 'info@petshopsby.com': 'company-email' },
    })
    const match = await findDuplicate(lookup, normalizeLead(full))

    expect(match).toEqual({
      companyId: 'company-domain',
      strategy: 'domain',
      matchedOn: 'petshopsby.com',
    })
    expect(lookup.calls).toEqual(['domain'])
  })

  it('falls through to phone when the domain misses', async () => {
    const lookup = fakeLookup({
      phone: { '+6281234567890': 'company-phone' },
      email: { 'info@petshopsby.com': 'company-email' },
    })
    const match = await findDuplicate(lookup, normalizeLead(full))

    expect(match?.strategy).toBe('phone')
    expect(match?.companyId).toBe('company-phone')
    expect(lookup.calls).toEqual(['domain', 'phone'])
  })

  it('falls through to email when domain and phone miss', async () => {
    const lookup = fakeLookup({ email: { 'info@petshopsby.com': 'company-email' } })
    const match = await findDuplicate(lookup, normalizeLead(full))

    expect(match?.strategy).toBe('email')
    expect(lookup.calls).toEqual(['domain', 'phone', 'email'])
  })

  it('falls through to fuzzy name and city last', async () => {
    const lookup = fakeLookup({
      fuzzy: { 'pet shop surabaya|surabaya': 'company-fuzzy' },
    })
    const match = await findDuplicate(lookup, normalizeLead(full))

    expect(match?.strategy).toBe('fuzzy_name_city')
    expect(lookup.calls).toEqual(['domain', 'phone', 'email', 'fuzzy_name_city'])
  })

  it('returns null when nothing matches', async () => {
    const lookup = fakeLookup({})
    expect(await findDuplicate(lookup, normalizeLead(full))).toBeNull()
    expect(lookup.calls).toEqual(['domain', 'phone', 'email', 'fuzzy_name_city'])
  })

  it('skips strategies whose identifier the item does not have', async () => {
    const lookup = fakeLookup({})
    await findDuplicate(lookup, normalizeLead({ companyName: 'Toko Bahagia' }))

    // No domain, phone or email, and no city — so only the lookups that could
    // possibly say anything are consulted. Fuzzy is skipped without a city.
    expect(lookup.calls).toEqual([])
  })

  it('does not fuzzy-match on name alone', async () => {
    const lookup = fakeLookup({ fuzzy: { 'toko bahagia|': 'wrong-company' } })
    const match = await findDuplicate(
      lookup,
      normalizeLead({ companyName: 'Toko Bahagia', phone: '081234567890' }),
    )

    expect(match).toBeNull()
    expect(lookup.calls).toEqual(['phone'])
  })

  it('matches a WhatsApp number against stored phones', async () => {
    const lookup = fakeLookup({ phone: { '+6281234567890': 'company-wa' } })
    const match = await findDuplicate(
      lookup,
      normalizeLead({ companyName: 'Toko Bahagia', whatsapp: '0812-3456-7890' }),
    )

    expect(match?.companyId).toBe('company-wa')
    expect(match?.strategy).toBe('phone')
  })

  it('finds the same company however the incoming phone is written', async () => {
    const lookup = fakeLookup({ phone: { '+62318765432': 'company-landline' } })

    for (const spelling of ['+62 31 8765432', '031-8765432', '62318765432']) {
      const match = await findDuplicate(
        lookup,
        normalizeLead({ companyName: 'Toko Bahagia', phone: spelling }),
      )
      expect(match?.companyId).toBe('company-landline')
    }
  })
})
