import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '@/lib/db/drizzle'
import { type Result, err, ok } from '@/lib/types/result'

import {
  type PlanAllocation,
  type PlanSkip,
  allocatePlan,
  planItemIdempotencyKey,
} from './allocate'
import { type PlanTransaction, loadPlanCandidates } from './context'
import {
  COUNTRY_PATTERN,
  LANGUAGE_PATTERN,
  type SearchWindow,
  buildSearchSpace,
  composeQuery,
  takeWindow,
} from './target'

/**
 * The day's plan, start to finish (ADR 0001 §2 steps 1-8, §6).
 *
 * One transaction: load every running campaign, decide the whole day in
 * `allocatePlan`, cut each campaign's window out of its space, and write the
 * cursors back. Decides nothing itself — the decision is pure and lives in
 * `allocate.ts`; this file is the I/O half, in the same shape as
 * `send-context.ts` around `send-guard.ts`.
 *
 * The transaction is not tidiness. The cursor write and the items handed to the
 * executor are one statement about the world: a plan issued whose cursor did not
 * move would re-issue the same window tomorrow, and a cursor moved for a plan
 * that was never returned would skip that ground for a whole lap.
 *
 * Returns a `Result`. The only error is "the plan could not be built at all";
 * every per-campaign failure is a `skipped` entry on a successful plan.
 */

/** Its own provider namespace in `webhook_events`; `n8n` is the ingest route's. */
const PLAN_PROVIDER = 'n8n_plan'

/**
 * One Serper request, in the shape it travels to n8n (ADR 0001 §5).
 *
 * Built here rather than mapped in the route, and checked against this schema
 * BEFORE the transaction commits. The cursor advance and the items handed out are
 * one statement about the world: an item that cannot be serialised has to take
 * the cursor write down with it, or the day is charged to the tenant and never
 * delivered. Validating after commit — which is where this lived until review —
 * meant one campaign with an 11-character language tag lost the whole estate a
 * day, permanently, because the retry saw `already_planned`.
 *
 * `gl` and `hl` are bounded by the patterns `target.ts` parses them with, not by
 * a second, narrower guess.
 */
export const planItemSchema = z.object({
  campaign_id: z.uuid(),
  /** Echoed verbatim into the ingest POST. Deterministic per (campaign, date, index). */
  idempotency_key: z.string().min(1).max(200),
  /** Fully composed. n8n concatenates nothing. */
  q: z.string().min(1).max(500),
  gl: z.string().regex(COUNTRY_PATTERN),
  hl: z.string().regex(LANGUAGE_PATTERN),
  num: z.int().min(1).max(10),
  page: z.int().min(1).max(10),
  endpoint: z.enum(['places', 'search']),
  /** So n8n can report the window back without parsing the key. */
  space_index: z.int().min(0),
  plan_date: z.iso.date(),
})

export type PlanItem = z.infer<typeof planItemSchema>

export type BuildPlanInput = {
  /** ISO date. The whole plan is bucketed on it; nothing here reads a clock. */
  readonly planDate: string
  /** The caller's key, claimed in `webhook_events` so a redelivery issues nothing twice. */
  readonly idempotencyKey: string
  readonly maxItems?: number
  /** Compute and return the same decision, writing nothing. */
  readonly dryRun: boolean
}

export type BuiltPlan = {
  readonly planDate: string
  readonly budget: number
  readonly items: readonly PlanItem[]
  readonly skipped: readonly PlanSkip[]
  readonly replayed: boolean
}

export type PlanError = {
  readonly kind: 'plan_failed'
  readonly message: string
}

export async function buildPlan(
  input: BuildPlanInput,
): Promise<Result<BuiltPlan, PlanError>> {
  try {
    return ok(await db.transaction((tx) => runPlan(tx, input)))
  } catch (error: unknown) {
    return err({
      kind: 'plan_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runPlan(tx: PlanTransaction, input: BuildPlanInput): Promise<BuiltPlan> {
  const candidates = await loadPlanCandidates(tx)
  const plan = allocatePlan({
    planDate: input.planDate,
    candidates,
    maxItems: input.maxItems,
  })

  // Read over every CANDIDATE workspace, not only the contributing ones, so the
  // answer to "have I handled this request before?" survives the cursor's own
  // `already_planned` rule short-circuiting the allocation to nothing.
  const seen = await findClaims(
    tx,
    input.idempotencyKey,
    input.planDate,
    [...new Set(candidates.map((c) => c.workspaceId))].sort(),
  )

  const unclaimed = [...new Set(plan.allocations.map((a) => a.workspaceId))]
    .sort()
    .filter((id) => !seen.has(id))
  // The read above answers the ordinary redelivery; this insert answers the
  // concurrent one, which is still in flight and therefore not yet readable. It
  // blocks on the unique index until the other transaction commits.
  const conflicted = input.dryRun
    ? new Set<string>()
    : await claim(tx, input.idempotencyKey, input.planDate, unclaimed)

  const handled = new Set([...seen, ...conflicted])

  const items: PlanItem[] = []
  const skipped: PlanSkip[] = [...plan.skipped]

  for (const allocation of plan.allocations) {
    if (handled.has(allocation.workspaceId)) {
      // This request already issued this workspace's slice. Re-issuing the exact
      // window it got the first time is what ADR 0001 §4 uses `scrape_runs` for,
      // and that table is not built yet — so the replay contributes nothing
      // rather than guessing. Costs the tenant a day at worst; guessing would
      // cost Serper credits for ground that may already have been swept.
      skipped.push({
        campaignId: allocation.campaignId,
        workspaceId: allocation.workspaceId,
        reason: 'already_planned',
      })
      continue
    }

    // Rebuilt rather than carried out of `allocatePlan`, which only needed its
    // length. Holding every candidate's space to save one rebuild would mean
    // holding MAX_SPACE_SIZE items per running campaign at once.
    const space = buildSearchSpace(allocation.target)
    const window = takeWindow(
      space,
      { position: allocation.position, lap: allocation.lap },
      allocation.allocation,
    )

    const issued: PlanItem[] = []
    for (const item of window.items) {
      issued.push({
        campaign_id: allocation.campaignId,
        idempotency_key: planItemIdempotencyKey(
          allocation.campaignId,
          input.planDate,
          item.index,
        ),
        q: composeQuery(item.keyword, item.location),
        gl: allocation.target.country,
        hl: allocation.target.language,
        num: allocation.target.resultsPerRequest,
        page: item.page,
        endpoint: allocation.target.endpoint,
        space_index: item.index,
        plan_date: input.planDate,
      })
    }

    if (!input.dryRun) {
      const recorded = await writeCursor(tx, allocation, window, input.planDate)
      if (!recorded) {
        // The cursor row exists and belongs to somebody else, so the upsert's
        // `setWhere` refused it — Postgres updates no row and raises nothing.
        // The searches must not go out: nothing would record that they had, and
        // the campaign would be re-issued the identical window tomorrow and
        // every day after, each one billed, each one a 200 with an empty
        // `skipped`. That is the failure this branch exists to make visible.
        skipped.push({
          campaignId: allocation.campaignId,
          workspaceId: allocation.workspaceId,
          reason: 'cursor_not_owned',
        })
        continue
      }
    }

    items.push(...issued)
  }

  // Inside the transaction, deliberately. Everything above is already durable at
  // this point but nothing is committed: an item this deployment cannot put on
  // the wire rolls back the cursor advance and the claim with it, so the caller's
  // retry gets a real plan instead of `already_planned` and a permanently lost
  // day. The same check after commit could only ever make the loss worse.
  const wire = z.array(planItemSchema).safeParse(items)
  if (!wire.success) {
    throw new Error(
      `plan item failed its own schema: ${JSON.stringify(wire.error.issues[0] ?? null)}`,
    )
  }

  return {
    planDate: plan.planDate,
    budget: plan.budget,
    items: wire.data,
    skipped,
    replayed: handled.size > 0,
  }
}

// -----------------------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------------------

/**
 * The plan request is cross-tenant, but `webhook_events.workspace_id` is NOT NULL
 * — correctly, because every other row in that table belongs to exactly one
 * tenant. So one request is claimed as one row per CONTRIBUTING workspace, keyed
 * `<idempotency_key>:<plan_date>:<workspace_id>`.
 *
 * That is the honest shape of what is being claimed. A plan is a fan-out of
 * per-workspace decisions for ONE DAY, and "this workspace's slice of request K
 * for 2026-09-23 has been issued" is the fact worth recording. It also keeps
 * CLAUDE.md rule 6 intact: every row carries the workspace of the campaign that
 * produced it, never a workspace the caller named.
 *
 * The date is in the key rather than assumed to be in the caller's: a key derived
 * from an n8n workflow or execution id — the obvious thing for the workflow this
 * endpoint is waiting on to do — is constant across days. Without the date,
 * claiming every workspace on day one would answer every later day with
 * `already_planned`, 200, zero items, for good, and nothing would look broken.
 */
function claimKeyFor(idempotencyKey: string, planDate: string, workspaceId: string): string {
  return `${idempotencyKey}:${planDate}:${workspaceId}`
}

/**
 * Claims each contributing workspace's slice, returning the ones that turned out
 * to be claimed already.
 *
 * Inserted before any cursor moves, so a concurrent redelivery blocks on the
 * unique index until this transaction commits and then finds the conflict,
 * rather than racing it into a double advance.
 */
async function claim(
  tx: PlanTransaction,
  idempotencyKey: string,
  planDate: string,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set()

  const claimed = await tx
    .insert(schema.webhookEvents)
    .values(
      workspaceIds.map((workspaceId) => ({
        workspaceId,
        provider: PLAN_PROVIDER,
        idempotencyKey: claimKeyFor(idempotencyKey, planDate, workspaceId),
        payload: { idempotency_key: idempotencyKey, plan_date: planDate },
        processedAt: new Date(),
      })),
    )
    .onConflictDoNothing({
      target: [schema.webhookEvents.provider, schema.webhookEvents.idempotencyKey],
    })
    .returning({ workspaceId: schema.webhookEvents.workspaceId })

  const inserted = new Set(claimed.map((row) => row.workspaceId))
  return new Set(workspaceIds.filter((id) => !inserted.has(id)))
}

/**
 * Which of these workspaces have already had this day's slice of this request
 * issued.
 *
 * Filtered on `workspace_id` as well as on the keys. The keys already embed the
 * workspace, so the predicate is redundant — but a read whose tenant safety comes
 * from how a string was built is a read that stops being safe the moment somebody
 * changes `claimKeyFor`. ADR 0001 §6 sanctions exactly one cross-tenant query,
 * and it is in `context.ts`; this is not it.
 */
async function findClaims(
  tx: PlanTransaction,
  idempotencyKey: string,
  planDate: string,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set()

  const rows = await tx
    .select({ workspaceId: schema.webhookEvents.workspaceId })
    .from(schema.webhookEvents)
    .where(
      and(
        eq(schema.webhookEvents.provider, PLAN_PROVIDER),
        inArray(schema.webhookEvents.workspaceId, [...workspaceIds]),
        inArray(
          schema.webhookEvents.idempotencyKey,
          workspaceIds.map((id) => claimKeyFor(idempotencyKey, planDate, id)),
        ),
      ),
    )

  return new Set(rows.map((row) => row.workspaceId))
}

// -----------------------------------------------------------------------------
// The cursor
// -----------------------------------------------------------------------------

/**
 * Writes back where the campaign now stands (ADR 0001 §2 step 8). Returns false
 * when the write was refused, which is never a reason to search anyway.
 *
 * Keyed by the `workspace_id` carried on the candidate row — never one the caller
 * supplied — on both the insert and the conflict path, which is what keeps the
 * cross-tenant read in `context.ts` inside ADR 0001 §6's second rule. `setWhere`
 * failing is silent in SQL: `ON CONFLICT DO UPDATE` with an unsatisfied predicate
 * updates nothing and raises nothing. `.returning()` is what turns that silence
 * into an answer, and the caller turns the answer into a `skipped` entry.
 *
 * WHAT SERIALISES THIS WRITE is the `FOR NO KEY UPDATE` that
 * `loadPlanCandidates` takes on the CAMPAIGN row, not a lock on the cursor row —
 * which, on the first day of a sweep, does not exist yet to be locked. Any second
 * writer of `scrape_cursors` must take that same campaign lock first. The obvious
 * candidate is the ingest path maintaining saturation counters (ADR 0001
 * Amendment 2, step 3): today it holds only `FOR KEY SHARE` on the campaign, so
 * it would serialise on the cursor row alone and two planners plus an ingest
 * would no longer agree on one ordering. Not built here; noted here because this
 * is the line it has to match.
 *
 * `lap_started_on` moves only when a lap actually begins: a reset, or a window
 * that wrapped. `tier_changed_on` moves only when the tier did, which is what
 * `TIER_COOLDOWN_DAYS` is measured against.
 */
async function writeCursor(
  tx: PlanTransaction,
  allocation: PlanAllocation,
  window: SearchWindow,
  planDate: string,
): Promise<boolean> {
  const startsNewLap = allocation.cursorReset || window.lap > allocation.lap

  const changes: Partial<schema.NewScrapeCursor> = {
    spaceFingerprint: allocation.spaceFingerprint,
    spaceSize: allocation.spaceSize,
    position: window.position,
    lap: window.lap,
    lastPlannedOn: planDate,
    tier: allocation.tier,
    updatedAt: new Date(),
  }
  if (startsNewLap) changes.lapStartedOn = planDate
  if (allocation.tierChanged) changes.tierChangedOn = planDate

  const written = await tx
    .insert(schema.scrapeCursors)
    .values({
      workspaceId: allocation.workspaceId,
      campaignId: allocation.campaignId,
      spaceFingerprint: allocation.spaceFingerprint,
      spaceSize: allocation.spaceSize,
      position: window.position,
      lap: window.lap,
      lapStartedOn: planDate,
      lastPlannedOn: planDate,
      tier: allocation.tier,
      tierChangedOn: allocation.tierChanged ? planDate : null,
    })
    .onConflictDoUpdate({
      target: schema.scrapeCursors.campaignId,
      set: changes,
      setWhere: eq(schema.scrapeCursors.workspaceId, allocation.workspaceId),
    })
    .returning({ id: schema.scrapeCursors.id })

  return written.length > 0
}
