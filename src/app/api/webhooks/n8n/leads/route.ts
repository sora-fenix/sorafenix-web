import { createHmac, timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db, schema } from '@/lib/db/drizzle'
import { serverEnv } from '@/lib/env'
import { type IngestItem, ingestLeads, rejectionsFor } from '@/lib/leads/ingest'

import { and, eq } from 'drizzle-orm'

/**
 * Lead ingestion from n8n (SPEC §2).
 *
 * Order of operations is the security property here:
 *   1. read the RAW body, 2. verify the signature over those exact bytes,
 *   3. only then parse it.
 * Verifying a re-serialised object instead would compare a signature against
 * bytes the sender never signed — whitespace, key order and unicode escaping all
 * differ — so the check would either fail constantly or, worse, be quietly
 * loosened until it passed.
 *
 * Errors are English machine codes, not Bahasa Indonesia. The consumer is n8n,
 * not a person; rule 8 governs copy shown to users.
 */

// node:crypto is not available on the edge runtime.
export const runtime = 'nodejs'

const PROVIDER = 'n8n'

/** Bounds the work one signed request can ask for. */
const MAX_ITEMS = 1000

const itemSchema = z.object({
  company_name: z.string().min(1).max(500),
  website: z.string().max(2048).nullish(),
  address: z.string().max(1000).nullish(),
  city: z.string().max(200).nullish(),
  phone: z.string().max(100).nullish(),
  whatsapp: z.string().max(100).nullish(),
  email: z.string().max(320).nullish(),
  category: z.string().max(200).nullish(),
  source_url: z.string().max(2048).nullish(),
  raw: z.unknown().optional(),
})

const payloadSchema = z.object({
  campaign_id: z.uuid(),
  source: z.enum(['serper_places', 'serper_search', 'csv']),
  idempotency_key: z.string().min(1).max(200),
  items: z.array(itemSchema).max(MAX_ITEMS),
})

type Payload = z.infer<typeof payloadSchema>

function toIngestItems(payload: Payload): IngestItem[] {
  return payload.items.map((item) => ({
    companyName: item.company_name,
    website: item.website ?? null,
    address: item.address ?? null,
    city: item.city ?? null,
    phone: item.phone ?? null,
    whatsapp: item.whatsapp ?? null,
    email: item.email ?? null,
    category: item.category ?? null,
    sourceUrl: item.source_url ?? null,
    raw: item.raw ?? item,
  }))
}

// -----------------------------------------------------------------------------
// Signature
// -----------------------------------------------------------------------------

const SIGNATURE_FORMAT = /^sha256=([a-f0-9]{64})$/i

/**
 * Constant-time comparison of `x-sora-signature` against an HMAC of the raw body.
 *
 * The format is checked before the compare so that `timingSafeEqual` is always
 * handed two buffers of equal length — it throws otherwise, and a throw here
 * would leak "your signature was the wrong length" as a distinct response.
 */
function signatureMatches(rawBody: string, header: string | null): boolean {
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

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text()

  if (!signatureMatches(rawBody, request.headers.get('x-sora-signature'))) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = payloadSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: z.treeifyError(parsed.error) },
      { status: 422 },
    )
  }
  const payload = parsed.data

  // The payload names a campaign, not a workspace. Resolving one from the other
  // is what stops a valid signature from writing into a workspace it was never
  // meant for: an unknown campaign id simply has no workspace to write to.
  const [campaign] = await db
    .select({
      id: schema.campaigns.id,
      workspaceId: schema.campaigns.workspaceId,
    })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, payload.campaign_id))
    .limit(1)

  if (campaign === undefined) {
    return NextResponse.json({ error: 'unknown_campaign' }, { status: 404 })
  }

  const items = toIngestItems(payload)

  const result = await db.transaction(async (tx) => {
    // Claiming the idempotency key first means a concurrent redelivery blocks on
    // the unique index until this transaction commits, rather than racing it.
    const claimed = await tx
      .insert(schema.webhookEvents)
      .values({
        workspaceId: campaign.workspaceId,
        provider: PROVIDER,
        idempotencyKey: payload.idempotency_key,
        payload: parsed.data,
      })
      .onConflictDoNothing({
        target: [schema.webhookEvents.provider, schema.webhookEvents.idempotencyKey],
      })
      .returning({ id: schema.webhookEvents.id })

    if (claimed[0] === undefined) {
      // Already handled. Report the same verdict without repeating any write:
      // rejections are a pure function of the payload, and everything that was
      // not rejected is, by definition, already stored.
      const rejected = rejectionsFor(items)
      return {
        accepted: items.length,
        inserted: 0,
        duplicates: items.length - rejected.length,
        rejected,
        replayed: true,
      }
    }

    const ingested = await ingestLeads(tx, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      source: payload.source,
      items,
    })

    await tx
      .update(schema.webhookEvents)
      .set({ processedAt: new Date() })
      .where(
        and(
          eq(schema.webhookEvents.workspaceId, campaign.workspaceId),
          eq(schema.webhookEvents.id, claimed[0].id),
        ),
      )

    return { ...ingested, replayed: false }
  })

  return NextResponse.json(result, { status: 200 })
}
