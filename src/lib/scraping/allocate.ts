import {
  type SearchTarget,
  buildSearchSpace,
  fingerprintTarget,
  parseTarget,
} from './target'

/**
 * The daily plan decision (ADR 0001 §3): who is swept today, how much, and from
 * where in their space.
 *
 * PURE. Nothing here imports the Drizzle handle, opens a socket or reads a clock
 * — the plan date is a parameter. That is what lets `pnpm test` assert the exact
 * numbers a paying client's Serper bill is made of with no `DATABASE_URL`, and it
 * is the same split as `send-guard.ts` / `send-context.ts`.
 *
 * The system degrades by contributing less, never by erroring: an invalid target,
 * a day already planned and an exhausted budget are all `skipped` entries, never
 * exceptions. `allocatePlan` is total.
 *
 * NOT IN THIS FILE YET: the quota gate. `quota_exhausted` and `subscription_lapsed`
 * (ADR 0001 §4) arrive with `workspaces.monthly_search_quota`, and the `pace` term
 * of §3's `desired` formula arrives with them, since it is a function of the
 * remaining quota. Both are additive: `SkipReason` gains two members and `desired`
 * gains one `min` argument.
 */

// -----------------------------------------------------------------------------
// Constants — named and exported so a change to what we spend is a reviewable diff
// -----------------------------------------------------------------------------

/** ~1.7h of sequential searching at 2.5s each, which is the binding constraint. */
export const DAILY_SEARCH_BUDGET = 2500

/** How many days one full pass over a campaign's space should take, per tier. */
export const TIER_DAYS = { burst: 5, steady: 30, maintenance: 90 } as const

/** A batch below this is not worth the day's rotation slot; see `allocatePlan`. */
export const MIN_BATCH = 10

/** One campaign's ceiling for one day, so a large space cannot swallow the budget. */
export const MAX_BATCH_PER_CAMPAIGN = 400

/** Share of the squeezed budget, per tier. A burst tenant is worth three maintenance ones. */
export const TIER_WEIGHT = { burst: 3, steady: 2, maintenance: 1 } as const

/** Below this many observations in 14 days, the saturation signal is noise. */
export const TIER_SAMPLE_MIN = 50

/** A tier may not change more often than this, so it cannot flap. */
export const TIER_COOLDOWN_DAYS = 7

/** New leads as a share of everything seen in 14 days, above which the ground is not yet covered. */
export const TIER_STEADY_MIN_NEW_RATIO = 0.25

export const SCRAPE_TIERS = ['burst', 'steady', 'maintenance'] as const

/** Mirrors the `scrape_tier` pgEnum. Declared here so this file imports no schema. */
export type ScrapeTier = (typeof SCRAPE_TIERS)[number]

// -----------------------------------------------------------------------------
// Inputs and outputs
// -----------------------------------------------------------------------------

/** The `scrape_cursors` row for one campaign, as the allocator reads it. */
export type CursorState = {
  readonly spaceFingerprint: string
  readonly spaceSize: number
  readonly position: number
  readonly lap: number
  /** ISO date. The rotation key: nulls are first in line. */
  readonly lastPlannedOn: string | null
  readonly tier: ScrapeTier
  /** ISO date, or null when the tier has never moved. */
  readonly tierChangedOn: string | null
}

/**
 * The saturation signal `scripts/lead-stats.ts` measures — new leads falling while
 * merged duplicates climb.
 *
 * Zeroes mean "no evidence", which `classifyTier` reads as "hold the current tier",
 * not as "nothing new, therefore saturated". Today the planner always passes
 * zeroes: counting leads is a lead read, and ADR 0001 §6 forbids the one
 * cross-tenant query from touching a lead.
 */
export type TierEvidence = {
  readonly newLast14: number
  readonly mergedLast14: number
}

export type PlanCandidate = {
  readonly campaignId: string
  readonly workspaceId: string
  /** Raw `campaigns.target` jsonb. Parsed here, because failing to parse is a skip. */
  readonly target: unknown
  readonly cursor: CursorState | null
  /**
   * A cursor row exists for this campaign but does not belong to its workspace,
   * so it was not read (`context.ts`).
   *
   * It must be its own signal rather than just a null cursor: a null cursor means
   * "never swept", which is the front of the rotation at full burst from index 0,
   * and the write that would record the sweep is the one write this planner is
   * not allowed to make. Left as a plain null, the campaign would be billed for
   * the same searches every day forever, on a 200, with nothing in `skipped`.
   */
  readonly cursorConflict: boolean
  readonly evidence: TierEvidence
}

/**
 * Why a campaign contributed nothing today. Part of the endpoint's contract, not
 * debug output: it is how the owner sees "client X got nothing, and why" without
 * reading a log.
 *
 * `cursor_not_owned` is the only member this file does not produce on its own
 * evidence — `plan.ts` raises it as well, when the cursor write comes back
 * refused. Both mean the same thing and both must be reported: a campaign whose
 * progress cannot be recorded must not be searched, or it is searched again
 * tomorrow, and the day after, at full burst, and every one of those days is
 * billed.
 */
export type SkipReason =
  | 'invalid_target'
  | 'already_planned'
  | 'no_budget'
  | 'cursor_not_owned'

export type PlanSkip = {
  readonly campaignId: string
  readonly workspaceId: string
  readonly reason: SkipReason
}

/** One campaign's share of the day, and the cursor state the window starts from. */
export type PlanAllocation = {
  readonly campaignId: string
  readonly workspaceId: string
  readonly target: SearchTarget
  /** Always > 0; a zero share is a `no_budget` skip instead. */
  readonly allocation: number
  readonly spaceFingerprint: string
  readonly spaceSize: number
  /** Index to issue from, already reset to 0 if the fingerprint moved. */
  readonly position: number
  readonly lap: number
  readonly tier: ScrapeTier
  /** True when `tier_changed_on` must be stamped with the plan date. */
  readonly tierChanged: boolean
  /** True when the target changed under the cursor, or there was no cursor at all. */
  readonly cursorReset: boolean
}

export type Plan = {
  readonly planDate: string
  /** What was actually spendable today: the budget after `maxItems`. */
  readonly budget: number
  readonly allocations: readonly PlanAllocation[]
  readonly skipped: readonly PlanSkip[]
}

export type AllocateInput = {
  /** ISO date. Every date comparison in here is against this, never a clock. */
  readonly planDate: string
  readonly candidates: readonly PlanCandidate[]
  /** Throughput the executor will accept today. The budget is the smaller of the two. */
  readonly maxItems?: number
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Whole days from one ISO date to another, or null when either is unreadable.
 *
 * UTC throughout and never `new Date(string)`: the plan date is a calendar day,
 * and parsing it in the server's local zone would make "seven days ago" answer
 * differently in Jakarta and in a CI container.
 */
function daysBetween(from: string, to: string): number | null {
  const start = ISO_DATE.exec(from)
  const end = ISO_DATE.exec(to)
  if (start === null || end === null) return null

  const utc = (match: RegExpExecArray): number =>
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))

  const millis = utc(end) - utc(start)
  if (Number.isNaN(millis)) return null
  return Math.floor(millis / 86_400_000)
}

// -----------------------------------------------------------------------------
// Tier
// -----------------------------------------------------------------------------

export type TierInput = {
  readonly currentTier: ScrapeTier
  /** Completed full passes. Zero means the space has never been walked once. */
  readonly lap: number
  readonly evidence: TierEvidence
  readonly tierChangedOn: string | null
  /** The plan date, not today's clock. */
  readonly today: string
}

/**
 * ADR 0001 §3. The saturation signal decides how fast a campaign should re-walk
 * its space: a lap every 5 days while the ground is new, every 90 once it is
 * covered and a lap only catches businesses that have opened since.
 *
 * The cooldown applies to EVERY change, including back to `burst`. Reading it any
 * other way would make the one rule that can fire on any day — `lap === 0` after a
 * target edit — the one rule that can flap, which is what the cooldown exists to
 * stop. The cost is bounded and in the safe direction: a campaign whose target was
 * just edited can stay in maintenance for up to `TIER_COOLDOWN_DAYS`, sweeping its
 * new space slowly for a week. It under-spends; it never over-spends.
 */
export function classifyTier(input: TierInput): ScrapeTier {
  const proposed = proposeTier(input)
  if (proposed === input.currentTier) return input.currentTier

  const changedOn = input.tierChangedOn
  if (changedOn === null) return proposed

  const since = daysBetween(changedOn, input.today)
  // An unreadable date holds the tier rather than freeing it: a stamp nobody can
  // read is not evidence that the cooldown has expired.
  if (since === null) return input.currentTier

  return since >= TIER_COOLDOWN_DAYS ? proposed : input.currentTier
}

function proposeTier(input: TierInput): ScrapeTier {
  if (input.lap <= 0) return 'burst'

  const sample = input.evidence.newLast14 + input.evidence.mergedLast14
  if (sample < TIER_SAMPLE_MIN) return input.currentTier

  const newShare = input.evidence.newLast14 / sample
  return newShare >= TIER_STEADY_MIN_NEW_RATIO ? 'steady' : 'maintenance'
}

// -----------------------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------------------

/**
 * The key n8n echoes verbatim into the ingest POST for one search.
 *
 * A pure function of `(campaign, plan date, space index)`, so a re-issued window
 * carries the keys it carried the first time and the ingest route's
 * `(provider, idempotency_key)` unique index recognises the replay. The campaign
 * id is in the key because that index is global, not per workspace.
 */
export function planItemIdempotencyKey(
  campaignId: string,
  planDate: string,
  spaceIndex: number,
): string {
  return `plan:${planDate}:${campaignId}:${spaceIndex}`
}

// -----------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------

type Prepared = {
  readonly candidate: PlanCandidate
  readonly target: SearchTarget
  readonly spaceFingerprint: string
  readonly spaceSize: number
  readonly position: number
  readonly lap: number
  readonly tier: ScrapeTier
  readonly tierChanged: boolean
  readonly cursorReset: boolean
  readonly desired: number
  readonly lastPlannedOn: string | null
}

export function allocatePlan(input: AllocateInput): Plan {
  const budget = effectiveBudget(input.maxItems)

  const prepared: Prepared[] = []
  const skipped: PlanSkip[] = []

  // Sorted by campaign id first, so every downstream tie-break is decided by a
  // stable order rather than by whatever order the database returned rows in.
  const candidates = [...input.candidates].sort((a, b) => compare(a.campaignId, b.campaignId))

  for (const candidate of candidates) {
    const target = parseTarget(candidate.target)
    if (!target.ok) {
      skipped.push(skip(candidate, 'invalid_target'))
      continue
    }

    if (candidate.cursorConflict) {
      // Checked before anything is decided, and before the dry-run path can
      // report a window this planner would not be allowed to record.
      skipped.push(skip(candidate, 'cursor_not_owned'))
      continue
    }

    const cursor = candidate.cursor
    if (cursor !== null && cursor.lastPlannedOn === input.planDate) {
      // Already swept today. Checked before anything is decided, so a second call
      // on the same day cannot advance a cursor twice — with or without the
      // webhook replay claim above it.
      skipped.push(skip(candidate, 'already_planned'))
      continue
    }

    const spaceFingerprint = fingerprintTarget(target.value)
    const spaceSize = buildSearchSpace(target.value).length

    // ADR 0001 §2 step 3: an index into a space that no longer exists is
    // meaningless, so editing the target restarts the space.
    const cursorReset = cursor === null || cursor.spaceFingerprint !== spaceFingerprint
    const position = cursorReset ? 0 : cursor.position
    const lap = cursorReset ? 0 : cursor.lap

    const currentTier = cursor?.tier ?? 'burst'
    const tier = classifyTier({
      currentTier,
      lap,
      evidence: candidate.evidence,
      tierChangedOn: cursor?.tierChangedOn ?? null,
      today: input.planDate,
    })

    const tierDesired = Math.ceil(spaceSize / TIER_DAYS[tier])

    prepared.push({
      candidate,
      target: target.value,
      spaceFingerprint,
      spaceSize,
      position,
      lap,
      tier,
      tierChanged: tier !== currentTier,
      cursorReset,
      desired: Math.min(tierDesired, MAX_BATCH_PER_CAMPAIGN),
      lastPlannedOn: cursor?.lastPlannedOn ?? null,
    })
  }

  const allocations = smooth(prepared, budget)

  const planned: PlanAllocation[] = []
  for (const item of prepared) {
    const allocation = allocations.get(item.candidate.campaignId) ?? 0
    if (allocation <= 0) {
      skipped.push(skip(item.candidate, 'no_budget'))
      continue
    }
    planned.push({
      campaignId: item.candidate.campaignId,
      workspaceId: item.candidate.workspaceId,
      target: item.target,
      allocation,
      spaceFingerprint: item.spaceFingerprint,
      spaceSize: item.spaceSize,
      position: item.position,
      lap: item.lap,
      tier: item.tier,
      tierChanged: item.tierChanged,
      cursorReset: item.cursorReset,
    })
  }

  return { planDate: input.planDate, budget, allocations: planned, skipped }
}

function skip(candidate: PlanCandidate, reason: SkipReason): PlanSkip {
  return { campaignId: candidate.campaignId, workspaceId: candidate.workspaceId, reason }
}

function effectiveBudget(maxItems: number | undefined): number {
  if (maxItems === undefined || !Number.isFinite(maxItems)) return DAILY_SEARCH_BUDGET
  return Math.max(0, Math.min(DAILY_SEARCH_BUDGET, Math.floor(maxItems)))
}

function compare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * ADR 0001 §3's smoothing, in three passes.
 *
 * 1. Weighted proportional share, floored.
 * 2. The remainder, by largest fractional part, ties broken by campaign id.
 * 3. The `MIN_BATCH` floor, in `(last_planned_on asc nulls first, campaign_id)`
 *    order — the anti-starvation rule, using state the cursor already keeps.
 *
 * Two clamps the ADR's formula does not spell out but its own definitions imply.
 * Nobody is ever allocated more than `desired`: a weight can pull a campaign's
 * proportional share above what its tier asked for, and paying Serper for a
 * faster lap than the tier decided would make `TIER_DAYS` advisory. And the floor
 * is funded by taking from the largest allocations rather than from thin air,
 * because the budget is the throughput of one sequential executor and handing out
 * more than it is a plan that does not finish.
 */
function smooth(prepared: readonly Prepared[], budget: number): Map<string, number> {
  const allocation = new Map<string, number>()
  if (prepared.length === 0 || budget <= 0) return allocation

  const totalDesired = prepared.reduce((sum, item) => sum + item.desired, 0)
  if (totalDesired <= budget) {
    for (const item of prepared) allocation.set(item.candidate.campaignId, item.desired)
    return allocation
  }

  // Scarce. Rotation order decides who is served at all, and who gives up units
  // to fund somebody else's floor.
  const rotation = [...prepared].sort(byRotation)

  // Whoever's floor still fits, in order. A budget too small for even one floor
  // buys nothing: a batch under `MIN_BATCH` is not worth a campaign's rotation
  // slot, and taking the slot would move its `last_planned_on` to the back of
  // tomorrow's queue for the sake of a handful of searches.
  const served: Prepared[] = []
  let floorSum = 0
  for (const item of rotation) {
    const floor = Math.min(MIN_BATCH, item.desired)
    if (floorSum + floor > budget) break
    floorSum += floor
    served.push(item)
  }
  if (served.length === 0) return allocation

  const weightedTotal = served.reduce(
    (sum, item) => sum + TIER_WEIGHT[item.tier] * item.desired,
    0,
  )

  const fraction = new Map<string, number>()
  let spent = 0
  for (const item of served) {
    const raw =
      weightedTotal === 0 ? 0 : (budget * (TIER_WEIGHT[item.tier] * item.desired)) / weightedTotal
    const base = Math.min(Math.floor(raw), item.desired)
    allocation.set(item.candidate.campaignId, base)
    fraction.set(item.candidate.campaignId, raw - Math.floor(raw))
    spent += base
  }

  distributeRemainder(served, allocation, fraction, budget - spent)
  enforceMinBatch(served, rotation, allocation)

  return allocation
}

function byRotation(a: Prepared, b: Prepared): number {
  const left = a.lastPlannedOn
  const right = b.lastPlannedOn
  if (left !== right) {
    // Nulls first: a campaign that has never been planned goes ahead of one that
    // was planned last month, which goes ahead of one planned yesterday.
    if (left === null) return -1
    if (right === null) return 1
    return compare(left, right)
  }
  return compare(a.candidate.campaignId, b.candidate.campaignId)
}

/**
 * Hands out what flooring left over, one unit per campaign per pass, in
 * `(largest fractional part, campaign id)` order.
 *
 * Passes rather than one sweep because a campaign already at `desired` cannot take
 * its unit, and the unit still has to go somewhere. Each pass either spends at
 * least one unit or ends the loop, so it terminates.
 */
function distributeRemainder(
  served: readonly Prepared[],
  allocation: Map<string, number>,
  fraction: Map<string, number>,
  remainder: number,
): void {
  const order = [...served].sort((a, b) => {
    const fa = fraction.get(a.candidate.campaignId) ?? 0
    const fb = fraction.get(b.candidate.campaignId) ?? 0
    if (fa !== fb) return fb - fa
    return compare(a.candidate.campaignId, b.candidate.campaignId)
  })

  let left = remainder
  while (left > 0) {
    let handedOut = 0
    for (const item of order) {
      if (left === 0) break
      const id = item.candidate.campaignId
      const current = allocation.get(id) ?? 0
      if (current >= item.desired) continue
      allocation.set(id, current + 1)
      left -= 1
      handedOut += 1
    }
    if (handedOut === 0) break
  }
}

/**
 * Raises every served campaign to `min(MIN_BATCH, desired)`, funded by the
 * campaigns holding the most above their own floor.
 *
 * The donor is chosen by largest surplus, ties broken by reverse rotation order:
 * the campaign most recently planned gives up its units first, which is the same
 * fairness rule that decided who was served at all. Total surplus always covers
 * total deficit here, because the served set was chosen so its floors fit the
 * budget and the budget is what has been handed out.
 */
function enforceMinBatch(
  served: readonly Prepared[],
  rotation: readonly Prepared[],
  allocation: Map<string, number>,
): void {
  const rotationIndex = new Map<string, number>()
  rotation.forEach((item, index) => rotationIndex.set(item.candidate.campaignId, index))

  const floorFor = (item: Prepared): number => Math.min(MIN_BATCH, item.desired)

  for (const item of [...served].sort(
    (a, b) =>
      (rotationIndex.get(a.candidate.campaignId) ?? 0) -
      (rotationIndex.get(b.candidate.campaignId) ?? 0),
  )) {
    const id = item.candidate.campaignId
    let need = floorFor(item) - (allocation.get(id) ?? 0)

    while (need > 0) {
      const donor = bestDonor(served, allocation, floorFor, rotationIndex, id)
      if (donor === null) break

      const donorId = donor.candidate.campaignId
      const surplus = (allocation.get(donorId) ?? 0) - floorFor(donor)
      const moved = Math.min(need, surplus)
      allocation.set(donorId, (allocation.get(donorId) ?? 0) - moved)
      allocation.set(id, (allocation.get(id) ?? 0) + moved)
      need -= moved
    }
  }
}

function bestDonor(
  served: readonly Prepared[],
  allocation: Map<string, number>,
  floorFor: (item: Prepared) => number,
  rotationIndex: Map<string, number>,
  exclude: string,
): Prepared | null {
  let best: Prepared | null = null
  let bestSurplus = 0

  for (const item of served) {
    const id = item.candidate.campaignId
    if (id === exclude) continue
    const surplus = (allocation.get(id) ?? 0) - floorFor(item)
    if (surplus <= 0) continue

    if (
      best === null ||
      surplus > bestSurplus ||
      (surplus === bestSurplus &&
        (rotationIndex.get(id) ?? 0) > (rotationIndex.get(best.candidate.campaignId) ?? 0))
    ) {
      best = item
      bestSurplus = surplus
    }
  }

  return best
}
