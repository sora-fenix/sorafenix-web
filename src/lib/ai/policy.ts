/**
 * The retry and escalation decisions behind `agent.ts`.
 *
 * Split out and kept import-free on purpose: `agent.ts` guards itself with
 * `server-only` and pulls in the Drizzle handle, which reads `DATABASE_URL` at
 * module load — so the unit suite cannot import it without being handed a
 * database URL it is meant to live without (.claude/rules/testing.md). These are
 * the branches with real consequences when a provider misbehaves, so they are the
 * ones that must be cheap to test. Same reasoning as decision 24.
 *
 * Errors are read by shape, not by class. The AI SDK's `APICallError` carries
 * `statusCode`, `isRetryable` and `responseHeaders`; matching on those properties
 * rather than on `instanceof` means a wrapped, re-thrown or faked error is
 * classified the same way the real one is.
 */

export type AgentErrorKind =
  /** No model has an API key configured. Nothing was attempted. */
  | 'no_model_available'
  /** The call exceeded its own deadline, or was aborted. */
  | 'timeout'
  /** HTTP 429 — provider quota. On the free tier this is the common one. */
  | 'rate_limited'
  /** Anything else the provider returned or the transport did. */
  | 'provider_error'
  /** The model answered, but not in the shape the Zod schema demands. */
  | 'invalid_output'

export type Classification = {
  readonly kind: AgentErrorKind
  /** Whether trying the same model again could plausibly work. */
  readonly retryable: boolean
}

/** Longest error text written to `ai_runs.error`. An HTML error page is not evidence. */
const MAX_ERROR_LENGTH = 500

const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000

// -----------------------------------------------------------------------------
// Reading unknown errors without asserting their type
// -----------------------------------------------------------------------------

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

function numberProperty(value: unknown, key: string): number | undefined {
  const found = property(value, key)
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

function stringProperty(value: unknown, key: string): string | undefined {
  const found = property(value, key)
  return typeof found === 'string' ? found : undefined
}

/** The error's constructor name, however it was thrown. */
function errorName(error: unknown): string {
  return stringProperty(error, 'name') ?? ''
}

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

/**
 * The AI SDK's names for "the model replied with something unusable". All three
 * mean the same thing to us: ask again, and if it happens twice the prompt is
 * wrong, not the provider.
 */
const INVALID_OUTPUT_ERRORS = new Set([
  'AI_NoObjectGeneratedError',
  'NoObjectGeneratedError',
  'AI_TypeValidationError',
  'TypeValidationError',
  'AI_JSONParseError',
  'JSONParseError',
])

const ABORT_ERRORS = new Set(['AbortError', 'TimeoutError'])

export function classifyError(error: unknown): Classification {
  const name = errorName(error)

  // Our own deadline, or a caller cancelling. One more attempt gets a fresh one.
  if (ABORT_ERRORS.has(name)) {
    return { kind: 'timeout', retryable: true }
  }

  if (INVALID_OUTPUT_ERRORS.has(name)) {
    return { kind: 'invalid_output', retryable: true }
  }

  const status = numberProperty(error, 'statusCode')

  if (status === 429) {
    return { kind: 'rate_limited', retryable: true }
  }

  if (status !== undefined && status >= 500) {
    return { kind: 'provider_error', retryable: true }
  }

  if (status !== undefined && status >= 400) {
    // 401 wrong key, 403 disabled, 400 malformed request. Repeating the same
    // request produces the same answer — escalate to the other model instead.
    return { kind: 'provider_error', retryable: false }
  }

  // No status: a transport failure, or an SDK error carrying its own verdict.
  const isRetryable = property(error, 'isRetryable')
  if (typeof isRetryable === 'boolean') {
    return { kind: 'provider_error', retryable: isRetryable }
  }

  return { kind: 'provider_error', retryable: false }
}

// -----------------------------------------------------------------------------
// Backoff
// -----------------------------------------------------------------------------

/**
 * Exponential backoff with jitter, in milliseconds.
 *
 * `random` is passed in rather than read from `Math.random()` so the schedule is
 * a pure function of its inputs and a test can pin both ends of the jitter band.
 * `attempt` is zero-based: the delay *before* retry number `attempt + 1`.
 *
 * Jitter spreads the retries of a batch that all hit the same quota wall in the
 * same second. Without it, a rate-limited batch retries in lockstep and hits the
 * wall again together.
 */
export function backoffMs(attempt: number, random: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempt, 0), MAX_BACKOFF_MS)
  // Full jitter over [0.5x, 1.5x] — never zero, never more than half again.
  const clamped = Math.min(Math.max(random, 0), 1)
  return Math.round(exponential * (0.5 + clamped))
}

/**
 * The provider's own `Retry-After`, in milliseconds, when it sent one.
 *
 * A 429 that names its own wait is telling us something our backoff curve cannot
 * know. Both the seconds form and the HTTP-date form are legal; only the seconds
 * form is handled, because that is what the model APIs send. A date is ignored
 * rather than misread.
 */
export function retryAfterMs(error: unknown): number | null {
  const headers = property(error, 'responseHeaders')
  const raw = stringProperty(headers, 'retry-after')
  if (raw === undefined) return null

  const seconds = Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return null

  return Math.round(seconds * 1000)
}

/** How long to wait before retrying, honouring the provider over our own curve. */
export function retryDelayMs(error: unknown, attempt: number, random: number): number {
  return retryAfterMs(error) ?? backoffMs(attempt, random)
}

// -----------------------------------------------------------------------------
// Error text
// -----------------------------------------------------------------------------

function describeWithoutMessage(error: unknown): string {
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? 'unknown error'
  } catch {
    // Circular structures exist, and a logger is not the place to find out.
    return 'unknown error'
  }
}

/** A bounded, human-readable message for `ai_runs.error` and the returned Result. */
export function errorMessage(error: unknown): string {
  const message = stringProperty(error, 'message') ?? describeWithoutMessage(error)
  const name = errorName(error)
  const full = name === '' ? message : `${name}: ${message}`

  return full.length <= MAX_ERROR_LENGTH ? full : `${full.slice(0, MAX_ERROR_LENGTH)}…`
}
