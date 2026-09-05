import { describe, expect, it } from 'vitest'

import {
  type FactorKey,
  type SubScore,
  FACTOR_KEYS,
  HOT_FLOOR,
  NEUTRAL_SCORE,
  SCORE_FACTORS,
  WARM_FLOOR,
  categoryFor,
  computeScore,
  weightsSumTo100,
} from '@/lib/scoring/rubric'

/**
 * The scoring scale is the product's opinion about which lead a salesperson opens
 * first. `.claude/rules/testing.md` makes this file non-negotiable, and the band
 * edges are the reason: one point either side of 80 changes a lead from "call this
 * morning" to "get to it this week".
 */

/** Every factor at the same sub-score, which makes the weighted total that score. */
function flat(score: number): Record<FactorKey, SubScore> {
  const entries = FACTOR_KEYS.map((key) => [key, { score, evidence: `bukti untuk ${key}` }])
  return Object.fromEntries(entries)
}

function withFactors(overrides: Partial<Record<FactorKey, number>>): Record<FactorKey, SubScore> {
  const base = flat(NEUTRAL_SCORE)
  for (const [key, score] of Object.entries(overrides)) {
    const factorKey = FACTOR_KEYS.find((candidate) => candidate === key)
    if (factorKey !== undefined && score !== undefined) {
      base[factorKey] = { score, evidence: `bukti untuk ${key}` }
    }
  }
  return base
}

describe('the factor table', () => {
  it('weights sum to exactly 100', () => {
    // The whole 0-100 scale depends on this. If it drifts, every stored score is
    // on a different scale from every score before it.
    expect(weightsSumTo100()).toBe(true)
  })

  it('carries the six factors SPEC §4 names, with its weights', () => {
    expect(SCORE_FACTORS.map((factor) => [factor.key, factor.weight])).toEqual([
      ['industry_fit', 25],
      ['product_need', 25],
      ['company_size', 15],
      ['decision_maker', 15],
      ['location', 10],
      ['digital_signals', 10],
    ])
  })

  it('labels every factor in Bahasa Indonesia', () => {
    // These reach a salesperson's screen. CLAUDE.md rule 8.
    for (const factor of SCORE_FACTORS) {
      expect(factor.label).not.toBe('')
      expect(factor.label).toMatch(/^[A-Z]/)
    }
    expect(SCORE_FACTORS.map((f) => f.label)).toContain('Kesesuaian industri')
  })
})

describe('categoryFor', () => {
  it('bands at the SPEC edges, not near them', () => {
    expect(categoryFor(100)).toBe('hot')
    expect(categoryFor(HOT_FLOOR)).toBe('hot')
    expect(categoryFor(HOT_FLOOR - 1)).toBe('warm')
    expect(categoryFor(WARM_FLOOR)).toBe('warm')
    expect(categoryFor(WARM_FLOOR - 1)).toBe('cold')
    expect(categoryFor(0)).toBe('cold')
  })
})

describe('computeScore', () => {
  it('returns the sub-score itself when every factor agrees', () => {
    // Weights sum to 100, so a flat input must come back unchanged.
    expect(computeScore(flat(0)).score).toBe(0)
    expect(computeScore(flat(50)).score).toBe(50)
    expect(computeScore(flat(77)).score).toBe(77)
    expect(computeScore(flat(100)).score).toBe(100)
  })

  it('weights the two 25-point factors hardest', () => {
    // 100 on industry_fit, 0 elsewhere → 25. Same input on location → 10.
    expect(computeScore(withFactors({ industry_fit: 100, product_need: 0, company_size: 0, decision_maker: 0, location: 0, digital_signals: 0 })).score).toBe(25)
    expect(computeScore(withFactors({ industry_fit: 0, product_need: 0, company_size: 0, decision_maker: 0, location: 100, digital_signals: 0 })).score).toBe(10)
  })

  it('scores a realistic hot lead', () => {
    // Strong fit and need, decent size, a real decision maker, right city.
    const breakdown = computeScore(
      withFactors({
        industry_fit: 92,
        product_need: 88,
        company_size: 80,
        decision_maker: 85,
        location: 90,
        digital_signals: 60,
      }),
    )
    // 23 + 22 + 12 + 12.75 + 9 + 6 = 84.75 → 85
    expect(breakdown.score).toBe(85)
    expect(breakdown.category).toBe('hot')
  })

  it('lands an all-neutral lead in the middle of warm, not hot', () => {
    // The state SPEC §4 forces when nothing is grounded. It must never look like
    // a recommendation.
    const breakdown = computeScore(flat(NEUTRAL_SCORE))
    expect(breakdown.score).toBe(50)
    expect(breakdown.category).toBe('warm')
  })

  it('keeps the stored factors adding up to the stored score', () => {
    // tests/integration/seed.test.ts asserts this same property against the
    // database. Both origins have to satisfy it or the column means two things.
    const breakdown = computeScore(withFactors({ industry_fit: 90, location: 20 }))
    const recomputed = Math.round(
      breakdown.factors.reduce((total, factor) => total + factor.score * factor.weight, 0) / 100,
    )
    expect(recomputed).toBe(breakdown.score)
  })

  it('stores every factor with its key, label, weight and evidence', () => {
    const breakdown = computeScore(flat(70))
    expect(breakdown.factors).toHaveLength(6)
    expect(breakdown.factors[0]).toEqual({
      key: 'industry_fit',
      label: 'Kesesuaian industri',
      weight: 25,
      score: 70,
      evidence: 'bukti untuk industry_fit',
    })
  })

  it('rounds half up, once, at the end', () => {
    // 50.5 must not be reachable as a stored score; the column is an integer.
    const breakdown = computeScore(withFactors({ industry_fit: 52, product_need: 52, company_size: 50, decision_maker: 50, location: 50, digital_signals: 50 }))
    expect(Number.isInteger(breakdown.score)).toBe(true)
    expect(breakdown.score).toBe(51)
  })

  it('clamps a sub-score the schema should already have rejected', () => {
    // Belt and braces: the rubric decides what a score means and must not be able
    // to emit 130 because something upstream stopped checking.
    expect(computeScore(flat(140)).score).toBe(100)
    expect(computeScore(flat(-40)).score).toBe(0)
  })

  it('treats a non-finite sub-score as neutral rather than as zero', () => {
    // NaN propagating would silently turn one bad factor into a cold lead.
    expect(computeScore(flat(Number.NaN)).score).toBe(NEUTRAL_SCORE)
  })
})
