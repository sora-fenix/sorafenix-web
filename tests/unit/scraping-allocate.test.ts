import { describe, expect, it } from 'vitest'

import {
  DAILY_SEARCH_BUDGET,
  MAX_BATCH_PER_CAMPAIGN,
  MIN_BATCH,
  type PlanCandidate,
  type ScrapeTier,
  TIER_COOLDOWN_DAYS,
  TIER_DAYS,
  TIER_SAMPLE_MIN,
  allocatePlan,
  classifyTier,
  planItemIdempotencyKey,
} from '@/lib/scraping/allocate'
import { fingerprintTarget, parseTarget } from '@/lib/scraping/target'

/**
 * ADR 0001 §3. These numbers are a Serper bill and a client's coverage, so the
 * assertions are exact wherever the algorithm is deterministic — which is
 * everywhere, by design.
 */

const PLAN_DATE = '2026-09-23'

const NO_EVIDENCE = { newLast14: 0, mergedLast14: 0 }

function target(keywords: number, locations: number, pages: number): unknown {
  return {
    version: 1,
    keywords: Array.from({ length: keywords }, (_, i) => `keyword-${i}`),
    locations: Array.from({ length: locations }, (_, i) => `location-${i}`),
    pages: Array.from({ length: pages }, (_, i) => i + 1),
    country: 'id',
    language: 'id',
  }
}

/** 12 x 25 x 5 = 1500, the space size of the worked example and of `data-riil`. */
function space1500(): unknown {
  return target(12, 25, 5)
}

/**
 * What a campaign's tier asks for in a day, re-derived from ADR 0001 §3 rather
 * than read back out of the allocator. A test that asks the code under test what
 * it meant to do cannot catch it meaning the wrong thing.
 */
function desiredOf(spaceSize: number, tier: ScrapeTier): number {
  return Math.min(Math.ceil(spaceSize / TIER_DAYS[tier]), MAX_BATCH_PER_CAMPAIGN)
}

/** The fingerprint a cursor must carry to keep its place in that space. */
function fingerprintOf(value: unknown): string {
  const parsed = parseTarget(value)
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.error.issues.join('; ')}`)
  return fingerprintTarget(parsed.value)
}

function campaignId(index: number): string {
  return `campaign-${String(index).padStart(3, '0')}`
}

type CursorOverrides = {
  readonly spaceFingerprint?: string
  readonly spaceSize?: number
  readonly position?: number
  readonly lap?: number
  readonly lastPlannedOn?: string | null
  readonly tier?: ScrapeTier
  readonly tierChangedOn?: string | null
}

function candidate(
  index: number,
  overrides: {
    target?: unknown
    cursor?: CursorOverrides | null
    cursorConflict?: boolean
  } = {},
): PlanCandidate {
  const cursorOverrides = overrides.cursor
  return {
    campaignId: campaignId(index),
    workspaceId: `workspace-${String(index).padStart(3, '0')}`,
    cursorConflict: overrides.cursorConflict ?? false,
    // `in` rather than `??`, so a fixture can say "the target is null" and mean it.
    target: 'target' in overrides ? overrides.target : space1500(),
    cursor:
      cursorOverrides === undefined || cursorOverrides === null
        ? null
        : {
            spaceFingerprint: cursorOverrides.spaceFingerprint ?? 'unknown-fingerprint',
            spaceSize: cursorOverrides.spaceSize ?? 1500,
            position: cursorOverrides.position ?? 0,
            lap: cursorOverrides.lap ?? 0,
            lastPlannedOn: cursorOverrides.lastPlannedOn ?? null,
            tier: cursorOverrides.tier ?? 'burst',
            tierChangedOn: cursorOverrides.tierChangedOn ?? null,
          },
    evidence: NO_EVIDENCE,
  }
}

function allocationsById(candidates: readonly PlanCandidate[], maxItems?: number) {
  const plan = allocatePlan({ planDate: PLAN_DATE, candidates, maxItems })
  return {
    plan,
    byId: new Map(plan.allocations.map((a) => [a.campaignId, a.allocation])),
    skippedById: new Map(plan.skipped.map((s) => [s.campaignId, s.reason])),
  }
}

// -----------------------------------------------------------------------------
// classifyTier
// -----------------------------------------------------------------------------

describe('classifyTier', () => {
  const base = {
    currentTier: 'steady',
    lap: 3,
    evidence: NO_EVIDENCE,
    tierChangedOn: null,
    today: PLAN_DATE,
  } as const

  it('sends a space that has never been walked to burst', () => {
    expect(classifyTier({ ...base, currentTier: 'maintenance', lap: 0 })).toBe('burst')
  })

  it('holds the current tier when the 14-day sample is too small', () => {
    // 49 observations, all of them new: the strongest possible "not saturated"
    // signal, and still not enough evidence to move on.
    expect(
      classifyTier({
        ...base,
        currentTier: 'maintenance',
        evidence: { newLast14: TIER_SAMPLE_MIN - 1, mergedLast14: 0 },
      }),
    ).toBe('maintenance')
  })

  it('goes steady while at least a quarter of what it finds is new', () => {
    expect(
      classifyTier({
        ...base,
        currentTier: 'maintenance',
        evidence: { newLast14: 25, mergedLast14: 75 },
      }),
    ).toBe('steady')
  })

  it('goes maintenance once the ground is covered', () => {
    expect(
      classifyTier({ ...base, evidence: { newLast14: 24, mergedLast14: 76 } }),
    ).toBe('maintenance')
  })

  it('refuses a second change inside the cooldown', () => {
    expect(
      classifyTier({
        ...base,
        evidence: { newLast14: 5, mergedLast14: 95 },
        tierChangedOn: '2026-09-17',
      }),
    ).toBe('steady')
  })

  it('allows the change on the cooldown boundary', () => {
    expect(
      classifyTier({
        ...base,
        evidence: { newLast14: 5, mergedLast14: 95 },
        tierChangedOn: '2026-09-16',
      }),
    ).toBe('maintenance')
  })

  it('counts the cooldown in whole days from the plan date', () => {
    const changedOn = '2026-09-16'
    expect(TIER_COOLDOWN_DAYS).toBe(7)
    expect(
      classifyTier({
        ...base,
        evidence: { newLast14: 5, mergedLast14: 95 },
        tierChangedOn: changedOn,
        today: '2026-09-22',
      }),
    ).toBe('steady')
  })

  it('holds the tier when the change stamp is unreadable', () => {
    expect(
      classifyTier({
        ...base,
        evidence: { newLast14: 5, mergedLast14: 95 },
        tierChangedOn: 'yesterday',
      }),
    ).toBe('steady')
  })
})

// -----------------------------------------------------------------------------
// allocatePlan — the worked example
// -----------------------------------------------------------------------------

describe('allocatePlan — ADR 0001 §3 worked example', () => {
  it('splits a squeezed budget evenly across ten identical burst tenants', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i))
    const { plan, byId } = allocationsById(candidates)

    // tierDesired = ceil(1500 / 5) = 300 each, so 3000 asked against 2500.
    expect(TIER_DAYS.burst).toBe(5)
    expect(plan.budget).toBe(DAILY_SEARCH_BUDGET)
    expect(plan.allocations).toHaveLength(10)
    expect([...byId.values()]).toEqual(Array.from({ length: 10 }, () => 250))
    expect([...byId.values()].reduce((a, b) => a + b, 0)).toBe(DAILY_SEARCH_BUDGET)
    expect(plan.skipped).toEqual([])
  })

  it('gives everyone what they asked for when the day is not oversubscribed', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => candidate(i))
    const { byId } = allocationsById(candidates)

    expect([...byId.values()]).toEqual([300, 300, 300, 300, 300])
  })

  // The ADR's follow-on sentence — "add a tenant in maintenance (ceil(1500/90) =
  // 17) and it still gets its 17" — does NOT follow from the smoothing the same
  // section specifies. Proportional-to-(weight x desired) hands a maintenance
  // tenant 4 of 2500 next to ten bursting ones, and the MIN_BATCH floor lifts it
  // to 10. Asserted as it actually behaves, because the algorithm is what ships.
  it('lifts a squeezed maintenance tenant to the MIN_BATCH floor, not to its full ask', () => {
    const bursting = Array.from({ length: 10 }, (_, i) => candidate(i))
    // A real fingerprint, so the cursor keeps its lap and the tier survives the
    // reset rule: a mismatch would send it back to burst and to 300.
    const maintenance = candidate(10, {
      cursor: { lap: 4, tier: 'maintenance', spaceFingerprint: fingerprintOf(space1500()) },
    })
    const { byId } = allocationsById([...bursting, maintenance])

    expect(Math.ceil(1500 / TIER_DAYS.maintenance)).toBe(17)
    expect(byId.get(campaignId(10))).toBe(MIN_BATCH)
    expect([...byId.values()].reduce((a, b) => a + b, 0)).toBe(DAILY_SEARCH_BUDGET)
  })
})

// -----------------------------------------------------------------------------
// allocatePlan — skips
// -----------------------------------------------------------------------------

describe('allocatePlan — skipped', () => {
  it('skips an unparseable target instead of throwing', () => {
    const { plan, skippedById } = allocationsById([
      candidate(0, { target: { industries: ['Ritel'], cities: ['Surabaya'] } }),
      candidate(1),
    ])

    expect(skippedById.get(campaignId(0))).toBe('invalid_target')
    expect(plan.allocations.map((a) => a.campaignId)).toEqual([campaignId(1)])
  })

  it('skips a null target', () => {
    const { skippedById } = allocationsById([candidate(0, { target: null })])
    expect(skippedById.get(campaignId(0))).toBe('invalid_target')
  })

  /**
   * A cursor row that belongs to another workspace reads as no cursor at all,
   * which is the front of the rotation at full burst from index 0 — and the one
   * write that would record the sweep is the write this planner is not allowed
   * to make. Planning it anyway bills the same searches every day forever, on a
   * 200, with an empty `skipped`.
   */
  it('refuses to plan a campaign whose cursor belongs to another workspace', () => {
    const { plan, skippedById } = allocationsById([
      candidate(0, { cursorConflict: true }),
      candidate(1),
    ])

    expect(skippedById.get(campaignId(0))).toBe('cursor_not_owned')
    expect(plan.allocations.map((a) => a.campaignId)).toEqual([campaignId(1)])
  })

  it('skips a campaign already planned today, whatever else changed', () => {
    const { plan, skippedById } = allocationsById([
      candidate(0, { cursor: { lastPlannedOn: PLAN_DATE, spaceFingerprint: 'stale' } }),
    ])

    expect(skippedById.get(campaignId(0))).toBe('already_planned')
    expect(plan.allocations).toEqual([])
  })

  it('plans a campaign last swept yesterday', () => {
    const { byId } = allocationsById([
      candidate(0, { cursor: { lastPlannedOn: '2026-09-22' } }),
    ])
    expect(byId.get(campaignId(0))).toBe(300)
  })

  it('reports the squeezed-out campaigns as no_budget', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(i))
    const { plan, skippedById } = allocationsById(candidates, 100)

    expect(plan.allocations).toHaveLength(10)
    expect(plan.skipped).toHaveLength(20)
    expect([...skippedById.values()].every((reason) => reason === 'no_budget')).toBe(true)
  })

  it('plans nothing at all when the budget cannot cover one MIN_BATCH', () => {
    const { plan } = allocationsById([candidate(0), candidate(1)], MIN_BATCH - 1)

    expect(plan.allocations).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(['no_budget', 'no_budget'])
  })
})

// -----------------------------------------------------------------------------
// allocatePlan — the cursor
// -----------------------------------------------------------------------------

describe('allocatePlan — cursor', () => {
  it('emits from index 0 when the target changed under the cursor', () => {
    const { plan } = allocationsById([
      candidate(0, {
        cursor: { spaceFingerprint: 'a-space-that-no-longer-exists', position: 700, lap: 2 },
      }),
    ])

    const allocation = plan.allocations[0]
    expect(allocation).toBeDefined()
    if (allocation === undefined) return
    expect(allocation.cursorReset).toBe(true)
    expect(allocation.position).toBe(0)
    expect(allocation.lap).toBe(0)
    expect(allocation.tier).toBe('burst')
  })

  it('keeps its place when the fingerprint still matches', () => {
    const first = allocatePlan({ planDate: PLAN_DATE, candidates: [candidate(0)] })
    const fingerprint = first.allocations[0]?.spaceFingerprint
    expect(fingerprint).toBeDefined()
    if (fingerprint === undefined) return

    const { plan } = allocationsById([
      candidate(0, {
        cursor: { spaceFingerprint: fingerprint, position: 700, lap: 2, tier: 'steady' },
      }),
    ])

    const allocation = plan.allocations[0]
    expect(allocation).toBeDefined()
    if (allocation === undefined) return
    expect(allocation.cursorReset).toBe(false)
    expect(allocation.position).toBe(700)
    expect(allocation.lap).toBe(2)
    expect(allocation.tier).toBe('steady')
    expect(allocation.tierChanged).toBe(false)
    // steady walks the space in 30 days, not 5.
    expect(allocation.allocation).toBe(Math.ceil(1500 / TIER_DAYS.steady))
  })

  it('reports a tier change so the cooldown stamp can be written', () => {
    const { plan } = allocationsById([
      candidate(0, { cursor: { tier: 'maintenance', lap: 0, spaceFingerprint: 'stale' } }),
    ])

    const allocation = plan.allocations[0]
    expect(allocation).toBeDefined()
    if (allocation === undefined) return
    expect(allocation.tier).toBe('burst')
    expect(allocation.tierChanged).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// allocatePlan — the budget
// -----------------------------------------------------------------------------

describe('allocatePlan — budget', () => {
  it('never issues more than one campaign may take in a day', () => {
    // 60 x 250 x 1 = 15 000; ceil(15 000 / 5) = 3000, capped at 400.
    const { byId } = allocationsById([candidate(0, { target: target(60, 250, 1) })])
    expect(byId.get(campaignId(0))).toBe(MAX_BATCH_PER_CAMPAIGN)
  })

  it('takes the smaller of the day budget and what the executor will accept', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i))
    const { plan, byId } = allocationsById(candidates, 1000)

    expect(plan.budget).toBe(1000)
    expect([...byId.values()].reduce((a, b) => a + b, 0)).toBe(1000)
  })

  it('ignores a max_items above the day budget', () => {
    const { plan } = allocationsById([candidate(0)], 99_999)
    expect(plan.budget).toBe(DAILY_SEARCH_BUDGET)
  })

  // ADR 0001's risk table, row 3.
  it('keeps the sum of every allocation under the budget, over generated inputs', () => {
    let seed = 20260923
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    for (let run = 0; run < 200; run += 1) {
      const count = 1 + Math.floor(random() * 40)
      const maxItems = 1 + Math.floor(random() * 3000)
      const tiers: readonly ScrapeTier[] = ['burst', 'steady', 'maintenance']

      const specs = Array.from({ length: count }, (_, i) => {
        const storedTier = tiers[Math.floor(random() * tiers.length)] ?? 'burst'
        const keywords = 1 + Math.floor(random() * 20)
        const locations = 1 + Math.floor(random() * 20)
        const pages = 1 + Math.floor(random() * 5)
        const lap = Math.floor(random() * 3)
        const value = target(keywords, locations, pages)

        return {
          spaceSize: keywords * locations * pages,
          // With no evidence, `classifyTier` only ever fires the lap rule.
          tier: lap === 0 ? 'burst' : storedTier,
          candidate: candidate(i, {
            target: value,
            cursor: {
              lap,
              tier: storedTier,
              // A real fingerprint, so the generated lap and tier survive the
              // reset rule instead of collapsing every case to burst-from-zero.
              spaceFingerprint: fingerprintOf(value),
              position: Math.floor(random() * 100),
              lastPlannedOn: random() < 0.3 ? null : '2026-09-2' + Math.floor(random() * 3),
            },
          }),
        }
      })

      const candidates = specs.map((spec) => spec.candidate)
      const plan = allocatePlan({ planDate: PLAN_DATE, candidates, maxItems })
      const total = plan.allocations.reduce((sum, a) => sum + a.allocation, 0)
      const budget = Math.min(DAILY_SEARCH_BUDGET, maxItems)
      const totalDesired = specs.reduce(
        (sum, spec) => sum + desiredOf(spec.spaceSize, spec.tier),
        0,
      )

      expect(total).toBeLessThanOrEqual(budget)
      // Every campaign is accounted for exactly once, in one list or the other.
      expect(plan.allocations.length + plan.skipped.length).toBe(count)

      // The upper bound alone is satisfied by handing out nothing. These are the
      // lower bounds, and they are what a regression in the remainder loop's
      // `handedOut === 0` break or in enforceMinBatch's surplus accounting would
      // break: such a bug gives everybody one unit and still passes `<= budget`.
      if (totalDesired <= budget) {
        expect(total).toBe(totalDesired)
      } else {
        // Scarce. The served set is a prefix of the rotation whose floors fit, so
        // at most one campaign's floor can be left unspent.
        expect(total).toBeGreaterThan(budget - MIN_BATCH)
      }

      for (const allocation of plan.allocations) {
        const desired = desiredOf(allocation.spaceSize, allocation.tier)
        expect(allocation.allocation).toBeGreaterThan(0)
        // Nobody is squeezed below the floor that made them worth planning...
        expect(allocation.allocation).toBeGreaterThanOrEqual(Math.min(MIN_BATCH, desired))
        // ...and nobody is handed more than their tier asked for.
        expect(allocation.allocation).toBeLessThanOrEqual(desired)
        expect(allocation.allocation).toBeLessThanOrEqual(MAX_BATCH_PER_CAMPAIGN)
        // Never more than the space holds, so no day repeats a combination.
        expect(allocation.allocation).toBeLessThanOrEqual(allocation.spaceSize)
      }
    }
  })

  /**
   * `distributeRemainder` skips a campaign that is already at `desired` and hands
   * its unit to the next one. Nothing reached that branch: it needs a campaign
   * whose proportional share is clamped at a small `desired` while it also holds
   * the largest fractional part.
   *
   * Two campaigns, budget 15. A: maintenance over 1500 → desired 17, weight 1.
   * B: burst over 15 → desired 3, weight 3. Weighted total 17 + 9 = 26, so the
   * raw shares are 9.81 and 5.19 — B's 5 is clamped to its desired 3, and its
   * remainder pass is skipped three times over while A takes 9 → 12.
   */
  it('passes a remainder on when its owner is already at desired', () => {
    const smallSpace = target(3, 5, 1)
    const a = candidate(0, {
      cursor: {
        lap: 4,
        tier: 'maintenance',
        spaceFingerprint: fingerprintOf(space1500()),
      },
    })
    const b = candidate(1, {
      target: smallSpace,
      cursor: { lap: 2, tier: 'burst', spaceFingerprint: fingerprintOf(smallSpace) },
    })

    const { plan, byId } = allocationsById([a, b], 15)

    expect(plan.budget).toBe(15)
    expect(byId.get(campaignId(0))).toBe(12)
    expect(byId.get(campaignId(1))).toBe(3)
  })
})

// -----------------------------------------------------------------------------
// Anti-starvation
// -----------------------------------------------------------------------------

describe('allocatePlan — anti-starvation', () => {
  // ADR 0001's risk table, row 4: 30 campaigns, budget 100.
  it('plans every campaign at least once within three days', () => {
    const DAYS = ['2026-09-23', '2026-09-24', '2026-09-25'] as const
    const lastPlannedOn = new Map<string, string | null>()
    const everPlanned = new Set<string>()

    for (const day of DAYS) {
      const candidates = Array.from({ length: 30 }, (_, i) =>
        candidate(i, {
          cursor: { lastPlannedOn: lastPlannedOn.get(campaignId(i)) ?? null },
        }),
      )

      const plan = allocatePlan({ planDate: day, candidates, maxItems: 100 })

      expect(plan.allocations).toHaveLength(10)
      for (const allocation of plan.allocations) {
        expect(allocation.allocation).toBe(MIN_BATCH)
        lastPlannedOn.set(allocation.campaignId, day)
        everPlanned.add(allocation.campaignId)
      }
    }

    expect(everPlanned.size).toBe(30)
  })

  it('puts a campaign squeezed out today at the front of tomorrow', () => {
    const candidates = [
      candidate(0, { cursor: { lastPlannedOn: '2026-09-22' } }),
      candidate(1, { cursor: { lastPlannedOn: '2026-09-01' } }),
      candidate(2, { cursor: null }),
    ]
    const { plan } = allocationsById(candidates, MIN_BATCH * 2)

    // Never planned first, then oldest, then yesterday's.
    expect(plan.allocations.map((a) => a.campaignId)).toEqual([campaignId(1), campaignId(2)])
    expect(plan.skipped.map((s) => s.campaignId)).toEqual([campaignId(0)])
  })
})

// -----------------------------------------------------------------------------
// planItemIdempotencyKey
// -----------------------------------------------------------------------------

describe('planItemIdempotencyKey', () => {
  it('is a pure function of campaign, date and index', () => {
    expect(planItemIdempotencyKey('c-1', PLAN_DATE, 42)).toBe(
      planItemIdempotencyKey('c-1', PLAN_DATE, 42),
    )
    expect(planItemIdempotencyKey('c-1', PLAN_DATE, 42)).not.toBe(
      planItemIdempotencyKey('c-2', PLAN_DATE, 42),
    )
    expect(planItemIdempotencyKey('c-1', PLAN_DATE, 42)).not.toBe(
      planItemIdempotencyKey('c-1', '2026-09-24', 42),
    )
    expect(planItemIdempotencyKey('c-1', PLAN_DATE, 42)).not.toBe(
      planItemIdempotencyKey('c-1', PLAN_DATE, 43),
    )
  })

  it('fits the key column the ingest route validates', () => {
    const key = planItemIdempotencyKey('2f0f7a2e-2b3c-4d5e-8f90-1a2b3c4d5e6f', PLAN_DATE, 19_999)
    expect(key.length).toBeLessThanOrEqual(200)
  })
})
