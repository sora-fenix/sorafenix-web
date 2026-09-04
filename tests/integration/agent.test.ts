import type postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  type AgentDeps,
  type GenerateArgs,
  type GenerateOutput,
  productionDeps,
  runAgentWith,
} from '@/lib/ai/agent'
import { FALLBACK_MODEL, type ModelId, PRIMARY_MODEL } from '@/lib/ai/models'

import { openDatabase } from './helpers'

/**
 * `runAgent` against real Postgres, with a scripted provider.
 *
 * The provider is faked and everything else is real — including the `ai_runs`
 * writer, which is taken from `productionDeps()` so the rows asserted below are
 * written by the code that runs in production.
 *
 * Faking the provider is the point rather than a compromise. The behaviour worth
 * proving is what happens when a model is slow, throttled, mis-keyed or answers
 * with the wrong shape, and none of those can be summoned on demand from a real
 * one. What a fake cannot prove — that the model id, the provider package and the
 * token mapping are right — is proved separately by `pnpm ai:smoke`.
 *
 * Its own workspace, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'agent-test-workspace'

/** What the scripted model is asked to produce. Small, and strict about it. */
const schema = z.object({
  verdict: z.enum(['hot', 'warm', 'cold']),
  confidence: z.number().min(0).max(1),
})

type Verdict = z.infer<typeof schema>

const GOOD_OBJECT: Verdict = { verdict: 'hot', confidence: 0.9 }

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string

type AiRunRow = {
  agent: string
  model: string
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: string | null
  latency_ms: number | null
  ok: boolean
  error: string | null
  created_at: Date
}

async function runsFor(id: string): Promise<AiRunRow[]> {
  return sql<AiRunRow[]>`
    select agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, created_at
    from ai_runs where workspace_id = ${id} order by created_at, id`
}

// -----------------------------------------------------------------------------
// The scripted provider
// -----------------------------------------------------------------------------

type Step = (args: GenerateArgs) => Promise<GenerateOutput>

/** An error shaped the way the AI SDK shapes one, without importing its classes. */
function apiError(statusCode: number): Error {
  const error = new Error(`provider returned ${statusCode}`)
  error.name = 'AI_APICallError'
  return Object.assign(error, { statusCode, isRetryable: statusCode >= 500 })
}

function answers(object: unknown, tokensIn = 1200, tokensOut = 300): Step {
  return () => Promise.resolve({ object, tokensIn, tokensOut })
}

function fails(statusCode: number): Step {
  return () => Promise.reject(apiError(statusCode))
}

/** Hangs forever, so only the deadline can end the attempt. */
function hangs(): Step {
  return () => new Promise<GenerateOutput>(() => {})
}

type Harness = {
  deps: AgentDeps
  calls: GenerateArgs[]
  sleeps: number[]
}

function harness(steps: readonly Step[], models: readonly ModelId[] = [PRIMARY_MODEL, FALLBACK_MODEL]): Harness {
  const calls: GenerateArgs[] = []
  const sleeps: number[] = []
  let index = 0

  return {
    calls,
    sleeps,
    deps: {
      ...productionDeps(),
      generate: (args) => {
        calls.push(args)
        const step = steps[index]
        index += 1
        if (step === undefined) {
          throw new Error(`the provider was called ${index} times; only ${steps.length} scripted`)
        }
        return step(args)
      },
      availableModels: () => models,
      // Backoff is unit-tested; waiting it out here would only slow the suite.
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      random: () => 0.5,
    },
  }
}

function call(deps: AgentDeps, overrides: { timeoutMs?: number; maxRetries?: number } = {}) {
  return runAgentWith(
    {
      workspaceId,
      agent: 'qualify',
      system: 'You grade leads.',
      prompt: 'Toko Hewan Bahagia, Surabaya.',
      schema,
      ...overrides,
    },
    deps,
  )
}

// -----------------------------------------------------------------------------

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${`${SLUG}-other`})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Agent Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Agent Test Other', ${`${SLUG}-other`})
    returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')

  workspaceId = ws.id
  otherWorkspaceId = other.id
})

afterEach(async () => {
  await sql`delete from ai_runs where workspace_id in (${workspaceId}, ${otherWorkspaceId})`
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${`${SLUG}-other`})`
  await sql.end()
  // drizzle.ts caches its pool on globalThis outside production; without closing
  // it the Vitest process would not exit.
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('the happy path', () => {
  it('returns the parsed object and writes one ai_runs row', async () => {
    const { deps, calls } = harness([answers(GOOD_OBJECT)])

    const result = await call(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.value).toEqual(GOOD_OBJECT)
    expect(result.value.model).toBe(PRIMARY_MODEL)
    expect(result.value.tokensIn).toBe(1200)
    expect(result.value.tokensOut).toBe(300)
    // 1200 in at $0.75/1M + 300 out at $3.75/1M.
    expect(result.value.costUsd).toBe(0.002025)
    expect(result.value.attempts).toHaveLength(1)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.modelId).toBe(PRIMARY_MODEL)
    expect(calls[0]?.system).toBe('You grade leads.')

    const rows = await runsFor(workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent: 'qualify',
      model: PRIMARY_MODEL,
      tokens_in: 1200,
      tokens_out: 300,
      cost_usd: '0.002025',
      ok: true,
      error: null,
    })
    expect(rows[0]?.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('writes the row under the workspace it was given and no other', async () => {
    // rule 6: ai_runs is workspace-scoped like every other domain table.
    const { deps } = harness([answers(GOOD_OBJECT)])
    await call(deps)

    expect(await runsFor(workspaceId)).toHaveLength(1)
    expect(await runsFor(otherWorkspaceId)).toHaveLength(0)
  })
})

describe('an answer in the wrong shape', () => {
  it('is rejected by the schema even when the provider accepted it', async () => {
    // The provider is asked for structured output, but agent.ts parses the result
    // itself. rules/ai.md: an unparseable response is an error path, not a cast.
    const { deps } = harness([answers({ verdict: 'lukewarm', confidence: 2 }), answers(GOOD_OBJECT)])

    const result = await call(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.attempts).toHaveLength(2)
    expect(result.value.attempts[0]).toMatchObject({
      ok: false,
      errorKind: 'invalid_output',
      model: PRIMARY_MODEL,
    })
    expect(result.value.attempts[0]?.error).toContain('did not match the schema')
  })

  it('gets exactly one more chance on the same model, then escalates', async () => {
    // Two bad shapes in a row means the prompt or the schema is wrong; a third
    // attempt on the same model only costs money.
    const { deps, calls } = harness([
      answers({ wrong: true }),
      answers({ wrong: true }),
      answers(GOOD_OBJECT),
    ])

    const result = await call(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model).toBe(FALLBACK_MODEL)
    expect(calls.map((c) => c.modelId)).toEqual([PRIMARY_MODEL, PRIMARY_MODEL, FALLBACK_MODEL])

    const rows = await runsFor(workspaceId)
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.model === PRIMARY_MODEL && !r.ok)).toHaveLength(2)
    expect(rows.filter((r) => r.model === FALLBACK_MODEL && r.ok)).toHaveLength(1)
  })

  it('records no tokens and no cost for the failed attempt', async () => {
    // The SDK throws before reporting usage. Zero is honest; a guess is not.
    const { deps } = harness([answers({ wrong: true }), answers(GOOD_OBJECT)])
    await call(deps)

    const rows = await runsFor(workspaceId)
    const failed = rows.filter((r) => !r.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ tokens_in: null, tokens_out: null, cost_usd: '0.000000' })
  })
})

describe('a throttled provider', () => {
  it('retries a 429, and waits in between', async () => {
    const { deps, sleeps } = harness([fails(429), answers(GOOD_OBJECT)])

    const result = await call(deps)

    expect(result.ok).toBe(true)
    expect(sleeps).toEqual([500])
  })

  it('gives up on the primary after its retry budget and escalates', async () => {
    const { deps, calls } = harness([
      fails(429),
      fails(429),
      fails(429),
      answers(GOOD_OBJECT),
    ])

    const result = await call(deps, { maxRetries: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.model).toBe(FALLBACK_MODEL)
    // 1 initial attempt + 2 retries on the primary, then the fallback.
    expect(calls.map((c) => c.modelId)).toEqual([
      PRIMARY_MODEL,
      PRIMARY_MODEL,
      PRIMARY_MODEL,
      FALLBACK_MODEL,
    ])
    expect(await runsFor(workspaceId)).toHaveLength(4)
  })
})

describe('a request the provider refuses', () => {
  it('does not retry a 401 — it escalates immediately', async () => {
    // A wrong key gives the same answer every time. Spending the retry budget on
    // it delays the model that would have worked.
    const { deps, calls, sleeps } = harness([fails(401), answers(GOOD_OBJECT)])

    const result = await call(deps)

    expect(result.ok).toBe(true)
    expect(calls.map((c) => c.modelId)).toEqual([PRIMARY_MODEL, FALLBACK_MODEL])
    expect(sleeps).toEqual([])
  })
})

describe('when nothing works', () => {
  it('returns the last failure with every attempt recorded', async () => {
    const { deps } = harness([fails(503), fails(503), fails(503), fails(500), fails(500), fails(500)])

    const result = await call(deps, { maxRetries: 2 })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.kind).toBe('provider_error')
    expect(result.error.attempts).toHaveLength(6)
    expect(result.error.attempts.every((a) => !a.ok)).toBe(true)

    const rows = await runsFor(workspaceId)
    expect(rows).toHaveLength(6)
    expect(rows.every((r) => !r.ok)).toBe(true)
    expect(rows[0]?.error).toContain('503')
  })

  it('reports a hung provider as a timeout, and stops waiting for it', async () => {
    const { deps } = harness([hangs(), hangs(), hangs(), hangs()])

    const startedAt = Date.now()
    const result = await call(deps, { timeoutMs: 40, maxRetries: 1 })
    const elapsed = Date.now() - startedAt

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('timeout')
    // Two models, two attempts each, none of them allowed to run long.
    expect(result.error.attempts).toHaveLength(4)
    expect(elapsed).toBeLessThan(5000)

    const rows = await runsFor(workspaceId)
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.error?.includes('did not answer within 40ms') === true)).toBe(true)
  })
})

describe('with no key configured', () => {
  it('fails before calling anything, and writes no ai_runs row', async () => {
    // A row here would claim a provider call that never happened.
    const { deps, calls } = harness([], [])

    const result = await call(deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('no_model_available')
    expect(result.error.message).toContain('GOOGLE_GENERATIVE_AI_API_KEY')
    expect(result.error.attempts).toEqual([])
    expect(calls).toEqual([])
    expect(await runsFor(workspaceId)).toHaveLength(0)
  })

  it('uses the only model that is configured', async () => {
    const { deps, calls } = harness([answers(GOOD_OBJECT)], [FALLBACK_MODEL])

    const result = await call(deps)

    expect(result.ok).toBe(true)
    expect(calls.map((c) => c.modelId)).toEqual([FALLBACK_MODEL])
  })
})
