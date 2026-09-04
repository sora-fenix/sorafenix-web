import { describe, expect, it } from 'vitest'

import {
  backoffMs,
  classifyError,
  errorMessage,
  retryAfterMs,
  retryDelayMs,
} from '@/lib/ai/policy'

/**
 * These are the decisions `agent.ts` makes when a provider misbehaves, and the
 * consequences of getting them wrong are all expensive in different directions:
 * retrying a 401 burns the fallback budget on a key that will never work,
 * *not* retrying a 429 throws away a lead the free tier would have served a
 * second later, and retrying a bad shape forever pays for the same wrong answer.
 */

/** An error shaped like the AI SDK's APICallError, without importing it. */
function apiError(fields: {
  statusCode?: number
  isRetryable?: boolean
  headers?: Record<string, string>
  message?: string
}): unknown {
  const error = new Error(fields.message ?? 'provider said no')
  error.name = 'AI_APICallError'
  return Object.assign(error, {
    statusCode: fields.statusCode,
    isRetryable: fields.isRetryable,
    responseHeaders: fields.headers,
  })
}

function named(name: string): Error {
  const error = new Error('something went wrong')
  error.name = name
  return error
}

describe('classifyError', () => {
  it('reads an abort as a timeout, and tries again', () => {
    // Our own deadline firing. A second attempt gets a fresh one.
    expect(classifyError(named('AbortError'))).toEqual({ kind: 'timeout', retryable: true })
    expect(classifyError(named('TimeoutError'))).toEqual({ kind: 'timeout', retryable: true })
  })

  it('recognises every name the SDK gives an unusable answer', () => {
    for (const name of [
      'AI_NoObjectGeneratedError',
      'NoObjectGeneratedError',
      'AI_TypeValidationError',
      'TypeValidationError',
      'AI_JSONParseError',
      'JSONParseError',
    ]) {
      expect(classifyError(named(name))).toEqual({ kind: 'invalid_output', retryable: true })
    }
  })

  it('separates rate limiting from every other provider failure', () => {
    // Distinct because the free tier hits this constantly and it answers to
    // waiting, where nothing else does.
    expect(classifyError(apiError({ statusCode: 429 }))).toEqual({
      kind: 'rate_limited',
      retryable: true,
    })
  })

  it('retries a server error', () => {
    for (const statusCode of [500, 502, 503, 529]) {
      expect(classifyError(apiError({ statusCode }))).toEqual({
        kind: 'provider_error',
        retryable: true,
      })
    }
  })

  it('does not retry a request the provider rejected', () => {
    // A wrong key, a disabled project, a malformed body: the same request gets
    // the same answer. Escalating to the other model is the only useful move.
    for (const statusCode of [400, 401, 403, 404]) {
      expect(classifyError(apiError({ statusCode }))).toEqual({
        kind: 'provider_error',
        retryable: false,
      })
    }
  })

  it('honours the SDK’s own verdict when there is no status code', () => {
    expect(classifyError(apiError({ isRetryable: true }))).toEqual({
      kind: 'provider_error',
      retryable: true,
    })
    expect(classifyError(apiError({ isRetryable: false }))).toEqual({
      kind: 'provider_error',
      retryable: false,
    })
  })

  it('prefers the status code over the SDK’s verdict', () => {
    // A 401 marked retryable is still a 401.
    expect(classifyError(apiError({ statusCode: 401, isRetryable: true }))).toEqual({
      kind: 'provider_error',
      retryable: false,
    })
  })

  it('classifies an abort before anything else on the same error', () => {
    const aborted = Object.assign(named('AbortError'), { statusCode: 429 })
    expect(classifyError(aborted)).toEqual({ kind: 'timeout', retryable: true })
  })

  it('gives up on an error it cannot read rather than retrying blindly', () => {
    expect(classifyError(new Error('boom'))).toEqual({
      kind: 'provider_error',
      retryable: false,
    })
    expect(classifyError('boom')).toEqual({ kind: 'provider_error', retryable: false })
    expect(classifyError(null)).toEqual({ kind: 'provider_error', retryable: false })
    expect(classifyError(undefined)).toEqual({ kind: 'provider_error', retryable: false })
  })
})

describe('backoffMs', () => {
  it('doubles the wait each attempt', () => {
    // Midpoint jitter (random 0.5) is the plain exponential value.
    expect(backoffMs(0, 0.5)).toBe(500)
    expect(backoffMs(1, 0.5)).toBe(1000)
    expect(backoffMs(2, 0.5)).toBe(2000)
    expect(backoffMs(3, 0.5)).toBe(4000)
  })

  it('spreads retries over half again either side', () => {
    expect(backoffMs(0, 0)).toBe(250)
    expect(backoffMs(0, 1)).toBe(750)
  })

  it('never waits nothing, so a wall is never hit at full speed', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(backoffMs(attempt, 0)).toBeGreaterThan(0)
    }
  })

  it('caps the curve', () => {
    expect(backoffMs(20, 0.5)).toBe(8000)
    expect(backoffMs(100, 1)).toBe(12000)
  })

  it('clamps nonsense inputs instead of returning one', () => {
    expect(backoffMs(-5, 0.5)).toBe(500)
    expect(backoffMs(0, -1)).toBe(250)
    expect(backoffMs(0, 5)).toBe(750)
  })
})

describe('retryAfterMs', () => {
  it('reads the seconds form the model APIs send', () => {
    expect(retryAfterMs(apiError({ statusCode: 429, headers: { 'retry-after': '30' } }))).toBe(
      30_000,
    )
    expect(retryAfterMs(apiError({ headers: { 'retry-after': ' 2 ' } }))).toBe(2000)
    expect(retryAfterMs(apiError({ headers: { 'retry-after': '0' } }))).toBe(0)
  })

  it('ignores the HTTP-date form rather than misreading it', () => {
    // Legal HTTP, never sent by these providers. Falling back to our own curve
    // is safer than parsing a date badly and waiting a decade.
    expect(retryAfterMs(apiError({ headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }))).toBe(
      null,
    )
    expect(retryAfterMs(apiError({ headers: { 'retry-after': '-5' } }))).toBe(null)
  })

  it('is null when the provider said nothing', () => {
    expect(retryAfterMs(apiError({ statusCode: 429 }))).toBe(null)
    expect(retryAfterMs(new Error('boom'))).toBe(null)
    expect(retryAfterMs(null)).toBe(null)
  })
})

describe('retryDelayMs', () => {
  it('lets the provider overrule our curve', () => {
    const throttled = apiError({ statusCode: 429, headers: { 'retry-after': '7' } })
    expect(retryDelayMs(throttled, 0, 0.5)).toBe(7000)
  })

  it('falls back to the curve when it said nothing', () => {
    expect(retryDelayMs(apiError({ statusCode: 429 }), 1, 0.5)).toBe(1000)
  })
})

describe('errorMessage', () => {
  it('keeps the name and the message together', () => {
    expect(errorMessage(new Error('boom'))).toBe('Error: boom')
    expect(errorMessage(named('AI_APICallError'))).toBe('AI_APICallError: something went wrong')
  })

  it('bounds the text so an HTML error page cannot fill the column', () => {
    const long = errorMessage(new Error('x'.repeat(2000)))
    expect(long).toHaveLength(501)
    expect(long.endsWith('…')).toBe(true)
  })

  it('describes a throw that was not an Error', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage({ detail: 'no message field' })).toBe('{"detail":"no message field"}')
  })

  it('never throws on input a logger cannot serialise', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe('unknown error')
    expect(errorMessage(undefined)).toBe('unknown error')
  })
})
