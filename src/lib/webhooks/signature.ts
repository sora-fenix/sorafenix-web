import { createHmac, timingSafeEqual } from 'node:crypto'

import { serverEnv } from '@/lib/env'

/**
 * HMAC verification for the two n8n webhooks (ADR 0001 §5).
 *
 * Lifted out of `api/webhooks/n8n/leads/route.ts` unchanged when the plan route
 * became the second caller. Both routes share one secret because they are one
 * consumer across one trust boundary: a caller that may post leads may ask for a
 * plan, and a second secret would be a second thing to rotate for no gain.
 *
 * The caller must hand this the RAW request body, before any parse. Verifying a
 * re-serialised object compares the signature against bytes the sender never
 * signed — whitespace, key order and unicode escaping all differ — so the check
 * would either fail constantly or be quietly loosened until it passed.
 */

const SIGNATURE_FORMAT = /^sha256=([a-f0-9]{64})$/i

/**
 * Constant-time comparison of `x-sora-signature` against an HMAC of the raw body.
 *
 * The format is checked before the compare so that `timingSafeEqual` is always
 * handed two buffers of equal length — it throws otherwise, and a throw here
 * would leak "your signature was the wrong length" as a distinct response.
 */
export function verifyN8nSignature(rawBody: string, header: string | null): boolean {
  if (header === null) return false

  const match = SIGNATURE_FORMAT.exec(header.trim())
  if (match === null) return false

  const provided = match[1]
  if (provided === undefined) return false

  const expected = createHmac('sha256', serverEnv().N8N_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex')

  return timingSafeEqual(
    Buffer.from(provided.toLowerCase(), 'hex'),
    Buffer.from(expected, 'hex'),
  )
}
