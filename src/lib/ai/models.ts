/**
 * The model registry (.claude/rules/ai.md).
 *
 * Model ids live in this file and nowhere else. Changing one is a stack change —
 * CLAUDE.md §1 pins the primary and the fallback, so ask the owner first.
 *
 * Nothing here imports anything. It is a table of facts plus the arithmetic over
 * it, so the unit suite can assert every number without a provider, a key or a
 * database.
 *
 * The primary was `gemini-2.5-flash` until 2026-09-04, when the first real call
 * came back 404: "no longer available to new users". A model id can die without a
 * deprecation window and without anything in this repository changing, which is
 * why `pnpm ai:smoke` exists and why nothing here is inferred from documentation.
 */

export const PRIMARY_MODEL = 'gemini-3.7-flash'
export const FALLBACK_MODEL = 'gpt-4.1-mini'

export const MODEL_IDS = [PRIMARY_MODEL, FALLBACK_MODEL] as const
export type ModelId = (typeof MODEL_IDS)[number]

export type ModelProvider = 'google' | 'openai'

/**
 * The env var holding this provider's key. Named, not read — only `lib/env.ts`
 * may touch `process.env` (rule 1). `agent.ts` looks the value up through
 * `serverEnv()` using this key.
 */
export type ModelApiKeyVar = 'GOOGLE_GENERATIVE_AI_API_KEY' | 'OPENAI_API_KEY'

export type ModelSpec = {
  readonly id: ModelId
  readonly provider: ModelProvider
  readonly apiKeyVar: ModelApiKeyVar
  /** USD per 1,000,000 input tokens, paid tier. */
  readonly inputUsdPerMillion: number
  /** USD per 1,000,000 output tokens, paid tier. */
  readonly outputUsdPerMillion: number
}

/**
 * Prices are the published **paid-tier** rates, recorded even when the key in use
 * is a free-tier one that bills nothing.
 *
 * `ai_runs.cost_usd` exists to answer "what does this cost at volume". A column of
 * zeros answers nothing, and would become quietly wrong the day the project moves
 * to a paid key. Verified against the provider pricing pages on 2026-09-04; they
 * change without warning, and this is the one file to correct when they do.
 *
 * **Google's flash rate doubles on 2027-01-01** — $0.75/$3.75 becomes $1.50/$7.50.
 * Deliberately not modelled as a date-dependent rate: a cost estimate that changes
 * shape at midnight is harder to reason about than one line to edit. Edit it.
 */
export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    provider: 'google',
    apiKeyVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    apiKeyVar: 'OPENAI_API_KEY',
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 1.6,
  },
}

/** Escalation order: primary first, fallback second. `agent.ts` walks this. */
export const MODEL_CHAIN: readonly ModelId[] = [PRIMARY_MODEL, FALLBACK_MODEL]

/** `ai_runs.cost_usd` is numeric(12, 6), so six decimals is the storable precision. */
const COST_DECIMALS = 6

/**
 * Estimated cost of one call, in USD.
 *
 * "Estimated" is honest, not hedging: it ignores context caching, batch discounts
 * and the audio input rate, none of which the MVP uses. Unknown token counts are
 * treated as zero rather than guessed — a missing usage field must not invent
 * spend.
 */
export function estimateCostUsd(
  modelId: ModelId,
  tokensIn: number | null,
  tokensOut: number | null,
): number {
  const spec = MODELS[modelId]
  const input = ((tokensIn ?? 0) / 1_000_000) * spec.inputUsdPerMillion
  const output = ((tokensOut ?? 0) / 1_000_000) * spec.outputUsdPerMillion
  return round(input + output, COST_DECIMALS)
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function isModelId(value: string): value is ModelId {
  return MODEL_IDS.some((id) => id === value)
}
