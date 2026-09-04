import { describe, expect, it } from 'vitest'

import {
  FALLBACK_MODEL,
  MODELS,
  MODEL_CHAIN,
  MODEL_IDS,
  PRIMARY_MODEL,
  estimateCostUsd,
  isModelId,
} from '@/lib/ai/models'

/**
 * `ai_runs.cost_usd` is summed for billing, so the arithmetic behind it is worth
 * pinning. The registry assertions are here for a different reason: they fail
 * loudly if someone changes a model id or a provider binding, which CLAUDE.md §1
 * says is a stack change requiring the owner's approval, not a code edit.
 */

describe('the registry', () => {
  it('pins the primary and fallback CLAUDE.md §1 specifies', () => {
    expect(PRIMARY_MODEL).toBe('gemini-3.7-flash')
    expect(FALLBACK_MODEL).toBe('gpt-4.1-mini')
  })

  it('escalates primary first, fallback second', () => {
    expect(MODEL_CHAIN).toEqual(['gemini-3.7-flash', 'gpt-4.1-mini'])
  })

  it('has a spec for every id, keyed by its own id', () => {
    for (const id of MODEL_IDS) {
      expect(MODELS[id].id).toBe(id)
    }
  })

  it('binds each model to a different provider and key', () => {
    const providers = MODEL_IDS.map((id) => MODELS[id].provider)
    const keys = MODEL_IDS.map((id) => MODELS[id].apiKeyVar)
    expect(new Set(providers).size).toBe(MODEL_IDS.length)
    expect(new Set(keys).size).toBe(MODEL_IDS.length)
  })

  it('prices every model above zero on both directions', () => {
    // A zero here would silently record every call as free.
    for (const id of MODEL_IDS) {
      expect(MODELS[id].inputUsdPerMillion).toBeGreaterThan(0)
      expect(MODELS[id].outputUsdPerMillion).toBeGreaterThan(0)
    }
  })
})

describe('estimateCostUsd', () => {
  it('charges input and output at their own rates', () => {
    // 1M in at $0.75 + 1M out at $3.75.
    expect(estimateCostUsd('gemini-3.7-flash', 1_000_000, 1_000_000)).toBe(4.5)
    // 1M in at $0.40 + 1M out at $1.60.
    expect(estimateCostUsd('gpt-4.1-mini', 1_000_000, 1_000_000)).toBe(2)
  })

  it('computes a realistic single call', () => {
    // 1200 in, 300 out on the primary: 0.0009 + 0.001125.
    expect(estimateCostUsd('gemini-3.7-flash', 1200, 300)).toBe(0.002025)
  })

  it('is zero for a call that produced no tokens', () => {
    expect(estimateCostUsd('gemini-3.7-flash', 0, 0)).toBe(0)
  })

  it('treats an unknown token count as zero rather than guessing', () => {
    // A provider that omits usage must not invent spend.
    expect(estimateCostUsd('gemini-3.7-flash', null, null)).toBe(0)
    expect(estimateCostUsd('gemini-3.7-flash', 1_000_000, null)).toBe(0.75)
    expect(estimateCostUsd('gemini-3.7-flash', null, 1_000_000)).toBe(3.75)
  })

  it('rounds to the six decimals the column can store', () => {
    // 1 input token = $0.00000075, which numeric(12,6) cannot hold; it rounds up
    // rather than disappearing.
    expect(estimateCostUsd('gemini-3.7-flash', 1, 0)).toBe(0.000001)
    // 7 output tokens = $0.00002625 → 0.000026.
    expect(estimateCostUsd('gemini-3.7-flash', 0, 7)).toBe(0.000026)
  })

  it('never returns a value with more precision than the column', () => {
    const cost = estimateCostUsd('gpt-4.1-mini', 3457, 891)
    expect(cost).toBe(Number(cost.toFixed(6)))
  })
})

describe('isModelId', () => {
  it('accepts the registered ids', () => {
    expect(isModelId('gemini-3.7-flash')).toBe(true)
    expect(isModelId('gpt-4.1-mini')).toBe(true)
  })

  it('rejects anything else, including near misses', () => {
    // gemini-2.5-flash was the primary until Google closed it to new keys on
    // 2026-09-04. It is a near miss now, not a model.
    expect(isModelId('gemini-2.5-flash')).toBe(false)
    expect(isModelId('gemini-3.8-pro')).toBe(false)
    expect(isModelId('gpt-4.1')).toBe(false)
    expect(isModelId('')).toBe(false)
  })
})
