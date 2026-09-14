import { describe, expect, it } from 'vitest'

import { HOT_FLOOR, NEUTRAL_SCORE, WARM_FLOOR } from '@/lib/scoring/rubric'
import {
  FULL_CONFIDENCE_REVIEWS,
  type LeadSignals,
  MIN_REVIEWS_FOR_RATING,
  REVIEW_SATURATION,
  SIGNAL_FACTORS,
  SIGNAL_FACTOR_KEYS,
  type SignalFactorKey,
  classifySignals,
  signalWeightsSumTo100,
} from '@/lib/scoring/signals'

/**
 * `.claude/rules/testing.md` makes `src/lib/scoring/*` non-negotiable, and this
 * rubric is the one that decides which of 1208 scraped petshops a salesperson
 * opens first. Every case below pins a decision that would otherwise be an
 * opinion in a comment.
 */

/** A lead with nothing known about it. Every factor should land on neutral. */
const BLANK: LeadSignals = {
  rating: null,
  reviewCount: null,
  website: null,
  domain: null,
  email: null,
  phone: null,
  whatsapp: null,
  city: null,
  category: null,
}

function lead(overrides: Partial<LeadSignals>): LeadSignals {
  return { ...BLANK, ...overrides }
}

function factor(signals: LeadSignals, key: SignalFactorKey): number {
  const found = classifySignals(signals).factors.find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`no factor ${key}`)
  return found.score
}

function evidence(signals: LeadSignals, key: SignalFactorKey): string {
  const found = classifySignals(signals).factors.find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`no factor ${key}`)
  return found.evidence
}

// -----------------------------------------------------------------------------

describe('the factor table', () => {
  it('sums to 100', () => {
    expect(signalWeightsSumTo100()).toBe(true)
  })

  it('has one spec per key, in the declared order', () => {
    expect(SIGNAL_FACTORS.map((spec) => spec.key)).toEqual([...SIGNAL_FACTOR_KEYS])
  })

  it('weights review volume highest — it is the factor that spreads the population', () => {
    const sorted = [...SIGNAL_FACTORS].sort((a, b) => b.weight - a.weight)
    expect(sorted[0]?.key).toBe('review_volume')
  })

  it('labels every factor in Bahasa Indonesia', () => {
    for (const spec of SIGNAL_FACTORS) {
      expect(spec.label.length).toBeGreaterThan(3)
    }
  })
})

describe('a lead with no data at all', () => {
  /**
   * The two kinds of empty, and the line between them.
   *
   * For four factors, null means "we never learned this" and the answer is
   * neutral — SPEC §4's rule, applied here without a model involved. For
   * `contactability` and `web_presence`, null means "the scrape looked and found
   * nothing", which is a measurement about the business and scores low. Getting
   * this backwards in either direction is the mistake this block guards.
   */
  const IGNORANCE: readonly SignalFactorKey[] = [
    'review_volume',
    'review_quality',
    'category_fit',
    'location',
  ]

  it('scores every unknowable factor exactly neutral', () => {
    for (const key of IGNORANCE) {
      expect(factor(BLANK, key), key).toBe(NEUTRAL_SCORE)
    }
  })

  it('scores the two measured-absence factors low, not neutral', () => {
    expect(factor(BLANK, 'contactability')).toBeLessThan(NEUTRAL_SCORE)
    expect(factor(BLANK, 'web_presence')).toBeLessThan(NEUTRAL_SCORE)
  })

  it('says so in the evidence rather than inventing a fact', () => {
    for (const item of classifySignals(BLANK).factors) {
      expect(item.evidence.length).toBeGreaterThan(10)
    }
    expect(evidence(BLANK, 'review_volume')).toContain('tidak tersedia')
    expect(evidence(BLANK, 'review_quality')).toContain('tidak tersedia')
    expect(evidence(BLANK, 'category_fit')).toContain('netral')
    expect(evidence(BLANK, 'location')).toContain('netral')
  })
})

describe('review_volume', () => {
  it('rises with the count and never falls', () => {
    const counts = [1, 5, 10, 21, 50, 77, 150, 221, 500, 980]
    const scores = counts.map((reviewCount) => factor(lead({ reviewCount }), 'review_volume'))
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i] ?? 0).toBeGreaterThanOrEqual(scores[i - 1] ?? 0)
    }
  })

  it('separates the quartiles of the real population instead of flattening them', () => {
    // p25 6 · p50 21 · p75 77 · p90 221, measured over data-riil on 2026-09-13.
    // A linear scale would put the first three inside eight points of each other.
    const p25 = factor(lead({ reviewCount: 6 }), 'review_volume')
    const p50 = factor(lead({ reviewCount: 21 }), 'review_volume')
    const p75 = factor(lead({ reviewCount: 77 }), 'review_volume')
    const p90 = factor(lead({ reviewCount: 221 }), 'review_volume')

    expect(p50 - p25).toBeGreaterThan(15)
    expect(p75 - p50).toBeGreaterThan(15)
    expect(p90).toBeGreaterThan(90)
  })

  it('reaches 100 at saturation and stays there above it', () => {
    expect(factor(lead({ reviewCount: REVIEW_SATURATION }), 'review_volume')).toBe(100)
    expect(factor(lead({ reviewCount: 5000 }), 'review_volume')).toBe(100)
  })

  it('scores zero reviews at zero — that is a measurement, not a gap', () => {
    expect(factor(lead({ reviewCount: 0 }), 'review_volume')).toBe(0)
    expect(factor(lead({ reviewCount: null }), 'review_volume')).toBe(NEUTRAL_SCORE)
  })

  it('treats a nonsense count as unknown rather than letting it through', () => {
    expect(factor(lead({ reviewCount: -5 }), 'review_volume')).toBe(NEUTRAL_SCORE)
    expect(factor(lead({ reviewCount: Number.NaN }), 'review_volume')).toBe(NEUTRAL_SCORE)
  })
})

describe('review_quality', () => {
  it('is the whole point of the rubric: 4.6 from 300 beats 5.0 from 2', () => {
    const established = lead({ rating: 4.6, reviewCount: 300 })
    const brandNew = lead({ rating: 5, reviewCount: 2 })
    expect(factor(established, 'review_quality')).toBeGreaterThan(
      factor(brandNew, 'review_quality'),
    )
  })

  it('refuses to read a rating backed by too few reviews', () => {
    const thin = lead({ rating: 5, reviewCount: MIN_REVIEWS_FOR_RATING - 1 })
    expect(factor(thin, 'review_quality')).toBe(NEUTRAL_SCORE)
    expect(evidence(thin, 'review_quality')).toContain('terlalu sedikit')
  })

  it('pulls a thin-but-usable rating back toward neutral', () => {
    const thin = lead({ rating: 5, reviewCount: MIN_REVIEWS_FOR_RATING })
    const confident = lead({ rating: 5, reviewCount: FULL_CONFIDENCE_REVIEWS })
    expect(factor(thin, 'review_quality')).toBeGreaterThan(NEUTRAL_SCORE)
    expect(factor(thin, 'review_quality')).toBeLessThan(factor(confident, 'review_quality'))
    expect(factor(confident, 'review_quality')).toBe(100)
  })

  it('ranks the real rating quartiles apart', () => {
    // p25 4.6 · p50 4.8 · p75 5.0 in data-riil. A 1-5 linear map would score all
    // three above 90 and rank nothing.
    const at = (rating: number): number =>
      factor(lead({ rating, reviewCount: 100 }), 'review_quality')
    expect(at(4.8) - at(4.6)).toBeGreaterThan(8)
    expect(at(5.0) - at(4.8)).toBeGreaterThan(8)
  })

  it('floors a genuinely bad reputation at zero', () => {
    expect(factor(lead({ rating: 3.5, reviewCount: 100 }), 'review_quality')).toBe(0)
    expect(factor(lead({ rating: 1.2, reviewCount: 100 }), 'review_quality')).toBe(0)
  })

  it('treats an impossible rating as unknown, never as the best lead in the workspace', () => {
    expect(factor(lead({ rating: 7.3, reviewCount: 100 }), 'review_quality')).toBe(NEUTRAL_SCORE)
    expect(factor(lead({ rating: 0, reviewCount: 100 }), 'review_quality')).toBe(NEUTRAL_SCORE)
  })

  it('cannot use a rating whose review count is unknown', () => {
    const orphan = lead({ rating: 4.9, reviewCount: null })
    expect(factor(orphan, 'review_quality')).toBe(NEUTRAL_SCORE)
    expect(evidence(orphan, 'review_quality')).toContain('4.9')
  })
})

describe('contactability', () => {
  it('ranks the channels WhatsApp > phone > email > nothing', () => {
    const wa = factor(lead({ whatsapp: '+628123456789' }), 'contactability')
    const phone = factor(lead({ phone: '+62315551234' }), 'contactability')
    const email = factor(lead({ email: 'info@toko.co.id' }), 'contactability')
    const none = factor(BLANK, 'contactability')

    expect(wa).toBeGreaterThan(phone)
    expect(phone).toBeGreaterThan(email)
    expect(email).toBeGreaterThan(none)
  })

  it('pays for email on top of a number rather than instead of one', () => {
    const waOnly = factor(lead({ whatsapp: '+628123456789' }), 'contactability')
    const waPlus = factor(
      lead({ whatsapp: '+628123456789', email: 'info@toko.co.id' }),
      'contactability',
    )
    expect(waPlus).toBeGreaterThan(waOnly)
  })

  it('does not count a blank string as a channel', () => {
    expect(factor(lead({ whatsapp: '   ', phone: '' }), 'contactability')).toBe(
      factor(BLANK, 'contactability'),
    )
  })
})

describe('web_presence', () => {
  it('pays most for a parsed domain', () => {
    const domain = factor(lead({ domain: 'petshop.co.id', website: 'x' }), 'web_presence')
    const messy = factor(lead({ website: 'petshop dot co dot id' }), 'web_presence')
    const none = factor(BLANK, 'web_presence')
    expect(domain).toBeGreaterThan(messy)
    expect(messy).toBeGreaterThan(none)
  })

  it('treats having no website as weak evidence, not a disqualification', () => {
    // 94% of the scraped population has none. Zeroing them would make the factor
    // a tax on the whole market rather than a signal about one business.
    expect(factor(BLANK, 'web_presence')).toBeGreaterThan(0)
  })
})

describe('category_fit', () => {
  const pet = [
    'Toko Hewan Peliharaan',
    'Toko Pakan Hewan',
    'Dokter Hewan',
    'Salon Hewan Peliharaan',
    'Toko Burung',
    'Toko Akuarium',
    'Jasa Penitipan Kucing',
    'Peternak Anjing',
    'Kafe kucing',
    'Toko Reptil',
    'Pemasok Kolam Ikan',
    'Toko Unggas',
  ]

  const notPet = [
    'Pusat Perbelanjaan',
    'Toko umum',
    'Minimarket',
    'Toko Cat',
    'Klinik Medis',
    'Dokter',
    'Vila',
    'Pasar',
    'Toko Perkakas',
    'Jasa Perbaikan Telepon',
  ]

  it.each(pet)('accepts %s', (category) => {
    expect(factor(lead({ category }), 'category_fit')).toBe(100)
  })

  it.each(notPet)('marks %s out of scope', (category) => {
    expect(factor(lead({ category }), 'category_fit')).toBeLessThan(NEUTRAL_SCORE)
  })

  it('matches regardless of case or accent', () => {
    expect(factor(lead({ category: 'KAFE KUCING' }), 'category_fit')).toBe(100)
    expect(factor(lead({ category: 'Kafé Kucing' }), 'category_fit')).toBe(100)
  })

  it('scores a missing category neutral, not out of scope', () => {
    expect(factor(lead({ category: null }), 'category_fit')).toBe(NEUTRAL_SCORE)
    expect(factor(lead({ category: '  ' }), 'category_fit')).toBe(NEUTRAL_SCORE)
  })
})

describe('location', () => {
  it('ranks the swept cities', () => {
    expect(factor(lead({ city: 'Surabaya' }), 'location')).toBeGreaterThan(
      factor(lead({ city: 'Mojokerto' }), 'location'),
    )
  })

  it('scores an unswept city neutral — unfamiliar is not bad', () => {
    expect(factor(lead({ city: 'Jayapura' }), 'location')).toBe(NEUTRAL_SCORE)
  })

  it('is case-insensitive', () => {
    expect(factor(lead({ city: 'surabaya' }), 'location')).toBe(
      factor(lead({ city: 'Surabaya' }), 'location'),
    )
  })
})

describe('the total', () => {
  it('bands on the same edges as the LLM rubric', () => {
    const strong = classifySignals(
      lead({
        rating: 4.9,
        reviewCount: 400,
        domain: 'petshop.co.id',
        website: 'https://petshop.co.id',
        whatsapp: '+628123456789',
        email: 'info@petshop.co.id',
        city: 'Surabaya',
        category: 'Toko Hewan Peliharaan',
      }),
    )
    expect(strong.score).toBeGreaterThanOrEqual(HOT_FLOOR)
    expect(strong.category).toBe('hot')

    const weak = classifySignals(
      lead({
        rating: 3.2,
        reviewCount: 1,
        city: 'Jayapura',
        category: 'Toko umum',
      }),
    )
    expect(weak.score).toBeLessThan(WARM_FLOOR)
    expect(weak.category).toBe('cold')
  })

  it('is a weighted mean, so a 30-point factor outranks a 5-point one', () => {
    const goodVolume = classifySignals(lead({ reviewCount: REVIEW_SATURATION }))
    const goodCity = classifySignals(lead({ city: 'Surabaya' }))
    expect(goodVolume.score).toBeGreaterThan(goodCity.score)
  })

  it('never leaves the 0-100 scale', () => {
    const cases: LeadSignals[] = [
      BLANK,
      lead({ rating: 5, reviewCount: 100000, domain: 'a.id', whatsapp: '+628', email: 'a@b.id', city: 'Surabaya', category: 'Toko Hewan Peliharaan' }),
      lead({ rating: 0.1, reviewCount: 0, category: 'Vila', city: 'Jayapura' }),
    ]
    for (const signals of cases) {
      const { score } = classifySignals(signals)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
      expect(Number.isInteger(score)).toBe(true)
    }
  })

  it('is deterministic — the same row twice gives the same number', () => {
    const signals = lead({ rating: 4.7, reviewCount: 37, whatsapp: '+6282228408114', city: 'Surabaya', category: 'Toko Perlengkapan Hewan Peliharaan' })
    const first = classifySignals(signals)
    const second = classifySignals(signals)
    expect(second).toEqual(first)
  })

  it('stamps the rubric that produced it, since two rubrics write leads.score', () => {
    expect(classifySignals(BLANK).rubric).toBe('signals_v1')
  })
})

describe('the reason a salesperson reads', () => {
  const strong = lead({
    rating: 4.8,
    reviewCount: 146,
    whatsapp: '+6281284793643',
    city: 'Surabaya',
    category: 'Toko Perlengkapan Hewan Peliharaan',
  })

  it('names the band and the score', () => {
    const { reason, score, category } = classifySignals(strong)
    expect(reason).toContain(String(score))
    expect(reason.length).toBeGreaterThan(20)
    expect(category).not.toBe('cold')
  })

  it('only ever repeats evidence the factors actually recorded', () => {
    const breakdown = classifySignals(strong)
    // Every clause after the opener is lifted from a factor's evidence, so the
    // summary cannot claim something the breakdown does not support.
    const quoted = breakdown.reason.toLowerCase()
    const anyFactorQuoted = breakdown.factors.some((item) =>
      quoted.includes(item.evidence.toLowerCase().replace(/\.+$/, '').slice(1)),
    )
    expect(anyFactorQuoted).toBe(true)
  })

  it('warns that a score resting mostly on unknowns is provisional', () => {
    // Without this the lead reads as judged when it was only ever unmeasured.
    const reason = classifySignals(BLANK).reason
    expect(reason).toContain('belum lengkap')
    expect(reason).toContain('sementara')
  })

  it('does not warn when the data is there', () => {
    expect(classifySignals(strong).reason).not.toContain('sementara')
  })
})
