import { z } from 'zod'

import { FACTOR_KEYS } from '@/lib/scoring/rubric'

/**
 * What the qualification model is allowed to return (docs/SPEC.md §4).
 *
 * Two rules are enforced by the shape itself rather than by hoping:
 *
 * 1. **No final score.** There is no field for one. The model returns six
 *    sub-scores; `lib/scoring/rubric.ts` computes the total. A model that tried to
 *    hand back a total would have nowhere to put it.
 * 2. **Evidence is mandatory on every factor.** A factor with nothing behind it
 *    must score 50 and say so in words. Making evidence required means "I had no
 *    data" has to be written down instead of hidden behind a confident number.
 */

const evidence = z
  .string()
  .trim()
  .min(10, 'evidence must be a sentence, not a placeholder')
  .max(300)

const subScore = z.object({
  /** 0–100. The rubric weights it; the model never sees the weight. */
  score: z.number().int().min(0).max(100),
  evidence,
})

export type SubScoreOutput = z.infer<typeof subScore>

/**
 * Every factor is required. An object keyed by factor — rather than an array —
 * means a missing factor is a parse error, where an array would have quietly
 * arrived one element short.
 */
export const qualifySchema = z.object({
  factors: z.object({
    industry_fit: subScore,
    product_need: subScore,
    company_size: subScore,
    decision_maker: subScore,
    location: subScore,
    digital_signals: subScore,
  }),
  /** 2–3 sentences, Bahasa Indonesia. Shown to a salesperson on the lead. */
  reason: z.string().trim().min(20).max(600),
})

export type QualifyOutput = z.infer<typeof qualifySchema>

// A compile-time check that the schema's factor keys and the rubric's stay in step.
// Adding a factor to one and forgetting the other becomes a type error here rather
// than a runtime surprise in front of a salesperson.
type SchemaFactorKey = keyof QualifyOutput['factors']
type RubricFactorKey = (typeof FACTOR_KEYS)[number]
type _KeysMatch = [SchemaFactorKey, RubricFactorKey] extends [RubricFactorKey, SchemaFactorKey]
  ? true
  : never
const _keysMatch: _KeysMatch = true
void _keysMatch
