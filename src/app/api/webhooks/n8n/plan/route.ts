import { NextResponse } from 'next/server'
import { z } from 'zod'

import type { SkipReason } from '@/lib/scraping/allocate'
import { type PlanItem, buildPlan } from '@/lib/scraping/plan'
import { verifyN8nSignature } from '@/lib/webhooks/signature'

/**
 * The day's search plan for every tenant (ADR 0001 §5).
 *
 * n8n asks this route what to search and then executes it, one item at a time,
 * posting each result set to the ingest route beside this one. n8n holds no
 * tenant identity of its own any more: no `SORA_CAMPAIGN_ID`, no keyword list, no
 * calendar slice. Onboarding a client is a workspace, a campaign and a target.
 *
 * Auth is the ingest route's, verbatim and on purpose — raw body, HMAC over those
 * exact bytes, then parse — sharing `N8N_WEBHOOK_SECRET` because it is one
 * consumer across one trust boundary (`src/lib/webhooks/signature.ts`).
 *
 * A POST although it reads: it moves every cursor it plans, and an HMAC over a
 * raw body needs a body to sign.
 *
 * Errors are English machine codes, like the ingest route. The consumer is n8n,
 * not a person; rule 8 governs copy shown to users.
 *
 * NOT RATE LIMITED, inheriting the ingest route's reasoning: the signature is the
 * gate, and an attacker who can forge one has the secret and does not need a
 * flood. Revisit together, not one route at a time.
 */

// node:crypto is not available on the edge runtime.
export const runtime = 'nodejs'

const planRequestSchema = z.object({
  idempotency_key: z.string().min(1).max(200),
  /** Defaults to the server's today. Explicit for replay and for tests. */
  plan_date: z.iso.date().optional(),
  /** Throughput the executor will accept today. Server takes min(this, budget). */
  max_items: z.int().min(1).max(5000).optional(),
  /** Compute and return without advancing any cursor. */
  dry_run: z.boolean().default(false),
})

/**
 * The response envelope (ADR 0001 §5). `items` are parsed against
 * `planItemSchema` inside the transaction that issued them — the one place where
 * a serialisation failure can still roll the cursor back — so what is left here
 * is an envelope the compiler can pin whole: two generated strings, two integers
 * and a boolean, none of which carry tenant data. There is deliberately no
 * second, post-commit parse: it could only turn a bug into a discarded plan that
 * the retry would then refuse to reissue.
 *
 * `skipped` is part of the contract, not debug output: it is how the owner sees
 * "client X contributed nothing today, and why" without reading a log. A workspace
 * that contributes nothing produces an entry and a 200, never a 4xx. `SkipReason`
 * carries only the reasons this endpoint can currently produce; `quota_exhausted`
 * and `subscription_lapsed` land with the quota gate (ADR 0001 §4) and are
 * additive — a consumer that switches on the reason keeps working.
 */
type PlanResponse = {
  readonly plan_date: string
  readonly generated_at: string
  readonly budget: number
  readonly item_count: number
  readonly items: readonly PlanItem[]
  readonly skipped: readonly { campaign_id: string; reason: SkipReason }[]
  readonly replayed: boolean
}

/** UTC, and the caller may pin it. n8n runs on Asia/Jakarta, where the scheduled
 *  morning trigger falls on the same calendar day either way. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text()

  if (!verifyN8nSignature(rawBody, request.headers.get('x-sora-signature'))) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = planRequestSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: z.treeifyError(parsed.error) },
      { status: 422 },
    )
  }
  const payload = parsed.data

  const plan = await buildPlan({
    planDate: payload.plan_date ?? today(),
    idempotencyKey: payload.idempotency_key,
    maxItems: payload.max_items,
    dryRun: payload.dry_run,
  })

  if (!plan.ok) {
    console.error('[scraping] plan failed', plan.error.message)
    return NextResponse.json({ error: 'plan_failed' }, { status: 500 })
  }

  const body: PlanResponse = {
    plan_date: plan.value.planDate,
    generated_at: new Date().toISOString(),
    budget: plan.value.budget,
    item_count: plan.value.items.length,
    // Already parsed against `planItemSchema` inside the transaction that issued
    // them, which is the only place a serialisation failure can still be undone.
    items: plan.value.items,
    skipped: plan.value.skipped.map((entry) => ({
      campaign_id: entry.campaignId,
      reason: entry.reason,
    })),
    replayed: plan.value.replayed,
  }

  return NextResponse.json(body, { status: 200 })
}
