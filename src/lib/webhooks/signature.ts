import { createHmac, timingSafeEqual } from 'node:crypto'

import { serverEnv } from '@/lib/env'

/**
 * HMAC verification for every inbound webhook (ADR 0001 §5).
 *
 * Lifted out of `api/webhooks/n8n/leads/route.ts` unchanged when the plan route
 * became the second caller. Both n8n routes share one secret because they are one
 * consumer across one trust boundary: a caller that may post leads may ask for a
 * plan, and a second secret would be a second thing to rotate for no gain. WAHA is
 * a different sender with a different secret, a different header and a different
 * digest, so it gets its own verifier — over the same primitive.
 *
 * The caller must hand this the RAW request body, before any parse. Verifying a
 * re-serialised object compares the signature against bytes the sender never
 * signed — whitespace, key order and unicode escaping all differ — so the check
 * would either fail constantly or be quietly loosened until it passed.
 */

export type HmacAlgorithm = 'sha256' | 'sha512'

/** Hex digest length per algorithm. Used to reject a malformed header early. */
const DIGEST_HEX_LENGTH: Readonly<Record<HmacAlgorithm, number>> = {
  sha256: 64,
  sha512: 128,
}

const HEX = /^[a-f0-9]+$/i

/**
 * Constant-time comparison of a hex digest against an HMAC of the raw body.
 *
 * Pure: the secret and the algorithm are parameters, not environment reads, so the
 * unit suite can walk a tampered body, a truncated digest and an algorithm
 * mismatch without a `.env.local`. The two wrappers below are the only places the
 * secrets are chosen.
 *
 * The length and alphabet are checked before the compare so that `timingSafeEqual`
 * is always handed two buffers of equal length — it throws otherwise, and a throw
 * here would leak "your signature was the wrong length" as a distinct response.
 * `Buffer.from(…, 'hex')` silently truncates at the first non-hex character, which
 * is why the alphabet is checked rather than assumed.
 */
export function verifyHmacDigest(
  rawBody: string,
  providedHex: string | null,
  secret: string,
  algorithm: HmacAlgorithm,
): boolean {
  if (providedHex === null) return false

  const provided = providedHex.trim().toLowerCase()
  if (provided.length !== DIGEST_HEX_LENGTH[algorithm]) return false
  if (!HEX.test(provided)) return false

  const expected = createHmac(algorithm, secret).update(rawBody, 'utf8').digest('hex')

  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
}

// -----------------------------------------------------------------------------
// n8n — `x-sora-signature: sha256=<hex>`
// -----------------------------------------------------------------------------

const N8N_SIGNATURE_FORMAT = /^sha256=([a-f0-9]{64})$/i

export function verifyN8nSignature(rawBody: string, header: string | null): boolean {
  if (header === null) return false

  const match = N8N_SIGNATURE_FORMAT.exec(header.trim())
  if (match === null) return false

  const provided = match[1]
  if (provided === undefined) return false

  return verifyHmacDigest(rawBody, provided, serverEnv().N8N_WEBHOOK_SECRET, 'sha256')
}

// -----------------------------------------------------------------------------
// WAHA — `x-webhook-hmac: <hex>` plus `x-webhook-hmac-algorithm: sha512`
// -----------------------------------------------------------------------------

/**
 * WAHA sends the bare digest with no `algorithm=` prefix and names the algorithm
 * in a second header. Missing header means sha512, which is what WAHA documents
 * and sends; an unrecognised value is refused rather than guessed at.
 *
 * Letting the sender pick between sha256 and sha512 is not a downgrade — both are
 * keyed with the same secret and neither is forgeable — but a value outside that
 * set is either a WAHA we have not read the docs for or someone probing, and both
 * deserve a 401.
 */
export function parseHmacAlgorithm(header: string | null): HmacAlgorithm | null {
  if (header === null || header.trim() === '') return 'sha512'

  const value = header.trim().toLowerCase()
  if (value === 'sha256' || value === 'sha512') return value
  return null
}

/**
 * Verifies an inbound WAHA webhook.
 *
 * Returns false when `WAHA_WEBHOOK_HMAC_SECRET` is unset: the variable is optional
 * so the app boots without WhatsApp, and an unconfigured secret must mean "nothing
 * is accepted", never "everything is". A route that treated a missing secret as
 * "no verification needed" would be an open write endpoint the day someone
 * deployed without filling the variable in.
 */
export function verifyWahaSignature(
  rawBody: string,
  hmacHeader: string | null,
  algorithmHeader: string | null,
): boolean {
  const secret = serverEnv().WAHA_WEBHOOK_HMAC_SECRET
  if (secret === undefined) return false

  const algorithm = parseHmacAlgorithm(algorithmHeader)
  if (algorithm === null) return false

  return verifyHmacDigest(rawBody, hmacHeader, secret, algorithm)
}
