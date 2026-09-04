import 'server-only'

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import type { z } from 'zod'

import { db, schema } from '@/lib/db/drizzle'
import { serverEnv } from '@/lib/env'
import { type Result, err, ok } from '@/lib/types/result'

import { MODELS, MODEL_CHAIN, type ModelId, estimateCostUsd } from './models'
import {
  type AgentErrorKind,
  classifyError,
  errorMessage,
  retryDelayMs,
} from './policy'

/**
 * The single entry point for every LLM call (CLAUDE.md rule 2).
 *
 * Nothing else in the codebase may talk to a model provider. This file owns the
 * whole contract: Zod in and out, a deadline, retry with backoff, escalation from
 * the primary model to the fallback, and an `ai_runs` row for every attempt that
 * reached a provider.
 *
 * It never throws. Callers get a `Result` (rule 9), because a model being slow,
 * broken or over quota is an expected outcome of a sales pipeline, not an
 * exception.
 *
 * The provider call, the audit write and the clock are injectable — see
 * `AgentDeps`. `tests/integration/agent.test.ts` drives every failure path with a
 * scripted fake, so retry, escalation and timeout are proved without burning
 * quota or waiting on a real model to misbehave. Production callers use
 * `runAgent`, which wires the real ones.
 */

// -----------------------------------------------------------------------------
// Public shape
// -----------------------------------------------------------------------------

/** Matches the `agent` column on `ai_runs`. One per SPEC module that calls a model. */
export type AgentName =
  | 'enrich_company'
  | 'qualify'
  | 'generate_content'
  | 'classify_reply'

export type AgentInput<T> = {
  /** `ai_runs.workspace_id` is NOT NULL, and rule 6 requires it regardless. */
  readonly workspaceId: string
  readonly agent: AgentName
  /** Loaded from `src/lib/ai/prompts/` by the caller — never built inline (rules/ai.md). */
  readonly system: string
  readonly prompt: string
  /** From `src/lib/ai/schemas/`. The model's answer is parsed with it, never cast. */
  readonly schema: z.ZodType<T>
  readonly temperature?: number
  readonly maxOutputTokens?: number
  /** Deadline for a single attempt, not for the whole escalation. */
  readonly timeoutMs?: number
  /** Retries after a transient failure, per model. */
  readonly maxRetries?: number
}

export type AgentAttempt = {
  readonly model: ModelId
  readonly ok: boolean
  readonly latencyMs: number
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly costUsd: number
  readonly errorKind: AgentErrorKind | null
  readonly error: string | null
}

export type AgentSuccess<T> = {
  readonly value: T
  /** The model that actually answered — not necessarily the primary. */
  readonly model: ModelId
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly costUsd: number
  readonly latencyMs: number
  readonly attempts: readonly AgentAttempt[]
}

export type AgentError = {
  readonly kind: AgentErrorKind
  readonly message: string
  readonly attempts: readonly AgentAttempt[]
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_RETRIES = 2

/**
 * A malformed answer gets exactly one more chance on the same model. Models do
 * recover from a bad shape; if they do not, the prompt or the schema is wrong and
 * more attempts only cost money.
 */
const INVALID_OUTPUT_RETRIES = 1

// -----------------------------------------------------------------------------
// Injectable edges
// -----------------------------------------------------------------------------

export type GenerateArgs = {
  readonly modelId: ModelId
  readonly system: string
  readonly prompt: string
  readonly schema: z.ZodType<unknown>
  readonly temperature: number | undefined
  readonly maxOutputTokens: number | undefined
  readonly abortSignal: AbortSignal
}

export type GenerateOutput = {
  /** Validated again by `runAgent` against the caller's schema. */
  readonly object: unknown
  readonly tokensIn: number | null
  readonly tokensOut: number | null
}

export type RecordedRun = {
  readonly workspaceId: string
  readonly agent: AgentName
  readonly model: ModelId
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly costUsd: number
  readonly latencyMs: number
  readonly ok: boolean
  readonly error: string | null
}

export type AgentDeps = {
  readonly generate: (args: GenerateArgs) => Promise<GenerateOutput>
  readonly recordRun: (run: RecordedRun) => Promise<void>
  readonly availableModels: () => readonly ModelId[]
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly random: () => number
}

// -----------------------------------------------------------------------------
// Errors this module raises into its own catch
// -----------------------------------------------------------------------------

class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the model did not answer within ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

class AgentOutputError extends Error {
  constructor(issues: string) {
    super(`the model's answer did not match the schema: ${issues}`)
    // Classified as `invalid_output`, exactly like the SDK's own name for this.
    this.name = 'AI_TypeValidationError'
  }
}

// -----------------------------------------------------------------------------
// The entry point
// -----------------------------------------------------------------------------

export async function runAgent<T>(
  input: AgentInput<T>,
): Promise<Result<AgentSuccess<T>, AgentError>> {
  return runAgentWith(input, productionDeps())
}

export async function runAgentWith<T>(
  input: AgentInput<T>,
  deps: AgentDeps,
): Promise<Result<AgentSuccess<T>, AgentError>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES
  const models = deps.availableModels()

  if (models.length === 0) {
    // Nothing was attempted, so nothing is written to ai_runs. A row here would
    // claim a provider call that never happened.
    return err({
      kind: 'no_model_available',
      message:
        'No model has an API key configured. Set GOOGLE_GENERATIVE_AI_API_KEY ' +
        '(free tier at aistudio.google.com) or OPENAI_API_KEY in .env.local.',
      attempts: [],
    })
  }

  const attempts: AgentAttempt[] = []
  let lastFailure: { kind: AgentErrorKind; message: string } = {
    kind: 'provider_error',
    message: 'no attempt was made',
  }

  for (const modelId of models) {
    let transientLeft = maxRetries
    let invalidOutputLeft = INVALID_OUTPUT_RETRIES

    for (let attempt = 0; ; attempt += 1) {
      const startedAt = deps.now()

      try {
        const output = await callWithDeadline(deps, input, modelId, timeoutMs)
        const parsed = input.schema.safeParse(output.object)
        if (!parsed.success) {
          throw new AgentOutputError(summarizeIssues(parsed.error))
        }

        const record = await settle(deps, input, modelId, {
          startedAt,
          tokensIn: output.tokensIn,
          tokensOut: output.tokensOut,
          ok: true,
          errorKind: null,
          error: null,
        })
        attempts.push(record)

        return ok({
          value: parsed.data,
          model: modelId,
          tokensIn: record.tokensIn,
          tokensOut: record.tokensOut,
          costUsd: record.costUsd,
          latencyMs: record.latencyMs,
          attempts,
        })
      } catch (error) {
        const { kind, retryable } = classifyError(error)
        const message = errorMessage(error)
        lastFailure = { kind, message }

        // Tokens are unknown on a failure: the SDK throws before reporting usage,
        // so the cost of a failed call is recorded as zero rather than invented.
        attempts.push(
          await settle(deps, input, modelId, {
            startedAt,
            tokensIn: null,
            tokensOut: null,
            ok: false,
            errorKind: kind,
            error: message,
          }),
        )

        const budgetLeft = kind === 'invalid_output' ? invalidOutputLeft : transientLeft
        if (!retryable || budgetLeft <= 0) break

        if (kind === 'invalid_output') invalidOutputLeft -= 1
        else transientLeft -= 1

        await deps.sleep(retryDelayMs(error, attempt, deps.random()))
      }
    }
  }

  return err({ ...lastFailure, attempts })
}

// -----------------------------------------------------------------------------
// One attempt
// -----------------------------------------------------------------------------

async function callWithDeadline<T>(
  deps: AgentDeps,
  input: AgentInput<T>,
  modelId: ModelId,
  timeoutMs: number,
): Promise<GenerateOutput> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  // Raced rather than relying on the abort alone: a provider — or a fake — that
  // ignores the signal must still not hold a job open forever.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new AgentTimeoutError(timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      deps.generate({
        modelId,
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
        temperature: input.temperature,
        maxOutputTokens: input.maxOutputTokens,
        abortSignal: controller.signal,
      }),
      deadline,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type AttemptOutcome = {
  readonly startedAt: number
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly ok: boolean
  readonly errorKind: AgentErrorKind | null
  readonly error: string | null
}

/** Closes one attempt: computes its cost, writes its `ai_runs` row, returns it. */
async function settle<T>(
  deps: AgentDeps,
  input: AgentInput<T>,
  modelId: ModelId,
  outcome: AttemptOutcome,
): Promise<AgentAttempt> {
  const latencyMs = Math.max(deps.now() - outcome.startedAt, 0)
  const costUsd = estimateCostUsd(modelId, outcome.tokensIn, outcome.tokensOut)

  await deps.recordRun({
    workspaceId: input.workspaceId,
    agent: input.agent,
    model: modelId,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costUsd,
    latencyMs,
    ok: outcome.ok,
    error: outcome.error,
  })

  return {
    model: modelId,
    ok: outcome.ok,
    latencyMs,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costUsd,
    errorKind: outcome.errorKind,
    error: outcome.error,
  }
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

// -----------------------------------------------------------------------------
// The real edges
// -----------------------------------------------------------------------------

/**
 * Which models can actually be called, in escalation order.
 *
 * A model whose key is unset is *unavailable*, not an error — one configured
 * provider is enough to work, and during the MVP the free Google key is often the
 * only one there is.
 */
function configuredModels(): readonly ModelId[] {
  const env = serverEnv()
  return MODEL_CHAIN.filter((id) => {
    const key = env[MODELS[id].apiKeyVar]
    return key !== undefined && key !== ''
  })
}

/**
 * Keys are read through `serverEnv()` and handed to the provider explicitly. The
 * SDK would happily read `process.env` itself, but rule 1 says exactly one file
 * does that, and this is not it.
 */
function languageModel(modelId: ModelId, apiKey: string) {
  const spec = MODELS[modelId]
  switch (spec.provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId)
    case 'openai':
      return createOpenAI({ apiKey })(modelId)
  }
}

async function callProvider(args: GenerateArgs): Promise<GenerateOutput> {
  const apiKey = serverEnv()[MODELS[args.modelId].apiKeyVar]
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`${MODELS[args.modelId].apiKeyVar} is not set`)
  }

  const result = await generateObject({
    model: languageModel(args.modelId, apiKey),
    schema: args.schema,
    system: args.system,
    prompt: args.prompt,
    temperature: args.temperature,
    maxOutputTokens: args.maxOutputTokens,
    abortSignal: args.abortSignal,
    // Retries are this module's job, and doing them here as well would multiply
    // the two budgets together and hide the attempts from ai_runs.
    maxRetries: 0,
  })

  return {
    object: result.object,
    tokensIn: result.usage.inputTokens ?? null,
    tokensOut: result.usage.outputTokens ?? null,
  }
}

/**
 * The audit write is best-effort, on purpose.
 *
 * A Postgres hiccup must not discard a generation the provider was already paid
 * for. This is a deliberate, narrow exception to rule 10: the row is the record of
 * a call, not the product of one, and losing it is strictly better than losing the
 * answer. It is logged loudly so a systematic failure is visible.
 */
async function recordRunRow(run: RecordedRun): Promise<void> {
  try {
    await db.insert(schema.aiRuns).values({
      workspaceId: run.workspaceId,
      agent: run.agent,
      model: run.model,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      costUsd: run.costUsd.toFixed(6),
      latencyMs: run.latencyMs,
      ok: run.ok,
      error: run.error,
    })
  } catch (error) {
    console.error('[ai] failed to write ai_runs row', {
      workspaceId: run.workspaceId,
      agent: run.agent,
      model: run.model,
      reason: errorMessage(error),
    })
  }
}

/**
 * The real edges, as one object.
 *
 * Exported so the integration suite can replace the provider and the clock while
 * keeping the genuine `ai_runs` writer — the audit rows it asserts are then
 * written by the same code production uses, not by a copy of it.
 */
export function productionDeps(): AgentDeps {
  return {
    generate: callProvider,
    recordRun: recordRunRow,
    availableModels: configuredModels,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: () => Math.random(),
  }
}
