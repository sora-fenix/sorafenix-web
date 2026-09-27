import { NextResponse } from 'next/server'
import { z } from 'zod'

import { type InboundOutcome, handleWahaEvent, wahaEventSchema } from '@/lib/outreach/whatsapp-inbound'
import { verifyWahaSignature } from '@/lib/webhooks/signature'

/**
 * Inbound WhatsApp from WAHA (SPEC §6).
 *
 * Order of operations is the security property, exactly as in the n8n lead route:
 *   1. read the RAW body, 2. verify the HMAC over those exact bytes,
 *   3. only then parse it.
 * WAHA signs with HMAC-SHA512 and puts the digest in `x-webhook-hmac`, naming the
 * algorithm in `x-webhook-hmac-algorithm`. Verifying a re-serialised object would
 * compare the signature against bytes the sender never signed.
 *
 * This route COMPOSES; it decides nothing. The session→workspace resolution, the
 * idempotency claim and the writes all live in `lib/outreach/whatsapp-inbound.ts`,
 * whose header explains the two tables it may touch and the two it may not —
 * `suppressions` and `leads.status`. Neither is reachable from here, and
 * `tests/unit/whatsapp-inbound-capability.test.ts` fails if that ever stops being
 * true.
 *
 * Every accepted request answers 200, including the ones we deliberately do nothing
 * about: an event we do not handle, and a session no workspace owns. A webhook that
 * answers 4xx to those only teaches WAHA to redeliver them forever.
 *
 * Errors are English machine codes, not Bahasa Indonesia. The consumer is a bridge,
 * not a person; rule 8 governs copy shown to users.
 */

// node:crypto is not available on the edge runtime.
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text()

  if (
    !verifyWahaSignature(
      rawBody,
      request.headers.get('x-webhook-hmac'),
      request.headers.get('x-webhook-hmac-algorithm'),
    )
  ) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = wahaEventSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: z.treeifyError(parsed.error) },
      { status: 422 },
    )
  }

  const outcome: InboundOutcome = await handleWahaEvent(parsed.data)

  return NextResponse.json(outcome, { status: 200 })
}
