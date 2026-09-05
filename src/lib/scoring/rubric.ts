/**
 * The lead scoring rubric (docs/SPEC.md §4).
 *
 * The model returns per-factor sub-scores and nothing else; the weighted total is
 * computed here. That split is the point of the module: a number produced by code
 * is reproducible, auditable, and comparable between two leads scored a month
 * apart. A number produced by a model is none of those things.
 *
 * Nothing here imports anything, so every band edge and every rounding decision is
 * testable without a model, a key or a database — which
 * `.claude/rules/testing.md` requires of this directory.
 */

export const FACTOR_KEYS = [
  'industry_fit',
  'product_need',
  'company_size',
  'decision_maker',
  'location',
  'digital_signals',
] as const

export type FactorKey = (typeof FACTOR_KEYS)[number]

export type ScoreFactorSpec = {
  readonly key: FactorKey
  /** Bahasa Indonesia — this is shown to a salesperson, not to a developer. */
  readonly label: string
  readonly weight: number
}

/**
 * The six factors and their weights, verbatim from SPEC §4. They sum to 100, and
 * `weightsSumTo100()` exists so that stops being a comment and starts being a test.
 *
 * This is the single definition. `scripts/seed-data.ts` imports it rather than
 * keeping its own copy — two tables of the same weights drift, and the drift would
 * be silent because both sides would still add up to *something*.
 */
export const SCORE_FACTORS: readonly ScoreFactorSpec[] = [
  { key: 'industry_fit', label: 'Kesesuaian industri', weight: 25 },
  { key: 'product_need', label: 'Kebutuhan produk', weight: 25 },
  { key: 'company_size', label: 'Ukuran perusahaan', weight: 15 },
  { key: 'decision_maker', label: 'Ketersediaan pengambil keputusan', weight: 15 },
  { key: 'location', label: 'Lokasi', weight: 10 },
  { key: 'digital_signals', label: 'Sinyal digital / bisnis', weight: 10 },
]

export type LeadCategory = 'hot' | 'warm' | 'cold'

/** SPEC §4: 80–100 hot · 50–79 warm · 0–49 cold. */
export const HOT_FLOOR = 80
export const WARM_FLOOR = 50

/**
 * What a factor with no supporting stored data must score.
 *
 * SPEC §4: "Any factor whose evidence is not grounded in stored data must score 50
 * (neutral), not be guessed upward." This constant is exported so the prompt and
 * the rubric quote the same number instead of two places agreeing by luck.
 */
export const NEUTRAL_SCORE = 50

/** One factor as it is stored in `leads.score_factors`. */
export type StoredFactor = {
  readonly key: FactorKey
  readonly label: string
  readonly weight: number
  /** 0–100, from the model. */
  readonly score: number
  /** One sentence, Bahasa Indonesia, naming the stored fact it rests on. */
  readonly evidence: string
}

export type ScoreBreakdown = {
  readonly score: number
  readonly category: LeadCategory
  readonly factors: readonly StoredFactor[]
}

/** What the model is asked for, per factor. */
export type SubScore = {
  readonly score: number
  readonly evidence: string
}

export function categoryFor(score: number): LeadCategory {
  if (score >= HOT_FLOOR) return 'hot'
  if (score >= WARM_FLOOR) return 'warm'
  return 'cold'
}

/**
 * Weighted total, banded, with the factor rows to store alongside it.
 *
 * Sub-scores are clamped to 0–100 rather than trusted. The Zod schema already
 * rejects an out-of-range number, so this never fires in production — but the
 * rubric is the thing that decides what a score *means*, and it should not be able
 * to emit 130 because something upstream stopped checking.
 */
export function computeScore(subScores: Readonly<Record<FactorKey, SubScore>>): ScoreBreakdown {
  const factors: StoredFactor[] = SCORE_FACTORS.map((spec) => {
    const given = subScores[spec.key]
    return {
      key: spec.key,
      label: spec.label,
      weight: spec.weight,
      score: clamp(given.score),
      evidence: given.evidence,
    }
  })

  // Weights sum to 100, so dividing by 100 puts the total back on a 0–100 scale.
  const weighted = factors.reduce((total, factor) => total + factor.score * factor.weight, 0)
  const score = Math.round(weighted / 100)

  return { score, category: categoryFor(score), factors }
}

/** Guards the invariant the whole scale rests on. Asserted by the unit suite. */
export function weightsSumTo100(): boolean {
  return SCORE_FACTORS.reduce((total, factor) => total + factor.weight, 0) === 100
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL_SCORE
  return Math.min(Math.max(Math.round(value), 0), 100)
}
