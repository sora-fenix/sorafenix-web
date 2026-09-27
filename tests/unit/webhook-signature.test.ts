import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  type HmacAlgorithm,
  parseHmacAlgorithm,
  verifyHmacDigest,
} from '@/lib/webhooks/signature'

/**
 * The HMAC primitive both webhook routes stand on.
 *
 * `verifyN8nSignature` and `verifyWahaSignature` read their secrets from
 * `lib/env.ts`, which the unit suite deliberately has no values for, so what is
 * tested here is the pure core they both call — and the algorithm parameter WAHA
 * needed, which is the part that could have quietly broken the n8n routes.
 *
 * The n8n side keeps its own coverage in `tests/integration/ingest.test.ts`, driven
 * through the real route with the real secret.
 */

const SECRET = 'a'.repeat(32)
const BODY = '{"event":"message","session":"default"}'

function sign(body: string, algorithm: HmacAlgorithm, secret = SECRET): string {
  return createHmac(algorithm, secret).update(body, 'utf8').digest('hex')
}

describe('verifyHmacDigest', () => {
  it('accepts a sha256 digest of the exact body', () => {
    expect(verifyHmacDigest(BODY, sign(BODY, 'sha256'), SECRET, 'sha256')).toBe(true)
  })

  it('accepts a sha512 digest of the exact body', () => {
    expect(verifyHmacDigest(BODY, sign(BODY, 'sha512'), SECRET, 'sha512')).toBe(true)
  })

  it('is case-insensitive about the hex, since senders differ', () => {
    expect(
      verifyHmacDigest(BODY, sign(BODY, 'sha512').toUpperCase(), SECRET, 'sha512'),
    ).toBe(true)
  })

  it('tolerates surrounding whitespace in the header', () => {
    expect(verifyHmacDigest(BODY, `  ${sign(BODY, 'sha512')}\n`, SECRET, 'sha512')).toBe(true)
  })

  // The algorithm is not cosmetic: the two digests are different values, and a
  // route that verified sha512 bytes as sha256 would reject everything.
  it('refuses a sha256 digest presented as sha512, and the reverse', () => {
    expect(verifyHmacDigest(BODY, sign(BODY, 'sha256'), SECRET, 'sha512')).toBe(false)
    expect(verifyHmacDigest(BODY, sign(BODY, 'sha512'), SECRET, 'sha256')).toBe(false)
  })

  it('refuses a body that changed by one character', () => {
    const signature = sign(BODY, 'sha512')
    expect(verifyHmacDigest(`${BODY} `, signature, SECRET, 'sha512')).toBe(false)
  })

  it('refuses a digest made with another secret', () => {
    expect(
      verifyHmacDigest(BODY, sign(BODY, 'sha512', 'b'.repeat(32)), SECRET, 'sha512'),
    ).toBe(false)
  })

  it('refuses a missing header', () => {
    expect(verifyHmacDigest(BODY, null, SECRET, 'sha512')).toBe(false)
  })

  // timingSafeEqual throws on buffers of different length, and Buffer.from(…,'hex')
  // truncates at the first non-hex character. Both are why length and alphabet are
  // checked before the compare rather than after.
  it('refuses a truncated digest without throwing', () => {
    expect(verifyHmacDigest(BODY, sign(BODY, 'sha512').slice(0, 100), SECRET, 'sha512')).toBe(
      false,
    )
  })

  it('refuses a digest padded to the right length with non-hex characters', () => {
    const forged = `${sign(BODY, 'sha512').slice(0, 120)}zzzzzzzz`
    expect(forged).toHaveLength(128)
    expect(verifyHmacDigest(BODY, forged, SECRET, 'sha512')).toBe(false)
  })

  it('refuses an empty header', () => {
    expect(verifyHmacDigest(BODY, '', SECRET, 'sha512')).toBe(false)
  })
})

describe('parseHmacAlgorithm', () => {
  it('reads what WAHA sends', () => {
    expect(parseHmacAlgorithm('sha512')).toBe('sha512')
    expect(parseHmacAlgorithm('SHA512')).toBe('sha512')
    expect(parseHmacAlgorithm('sha256')).toBe('sha256')
  })

  it('defaults to sha512, which is what WAHA signs with', () => {
    expect(parseHmacAlgorithm(null)).toBe('sha512')
    expect(parseHmacAlgorithm('  ')).toBe('sha512')
  })

  it('refuses an algorithm it does not know instead of guessing one', () => {
    expect(parseHmacAlgorithm('md5')).toBeNull()
    expect(parseHmacAlgorithm('none')).toBeNull()
    expect(parseHmacAlgorithm('sha1')).toBeNull()
  })
})
