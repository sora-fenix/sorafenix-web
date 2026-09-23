import 'server-only'

import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import { db, schema } from '@/lib/db/drizzle'

import type { CursorState, PlanCandidate } from './allocate'

/**
 * Loads the campaigns a plan can be built from, and locks them (ADR 0001 §6).
 *
 * THE ONE DELIBERATE CROSS-WORKSPACE QUERY IN THE CODEBASE. Every other query on
 * the Drizzle handle filters `workspace_id` because the handle bypasses RLS
 * (CLAUDE.md rule 6). This one sweeps every tenant in a single pass, for the same
 * reason `leads_next_action_at_idx` exists: the planner runs once a day for all
 * tenants and then fans out per workspace.
 *
 * ADR 0001 §6 bounds it with three rules, all of which are visible here:
 *
 *  1. It selects PLAN COLUMNS ONLY — campaign identity, the target, and the
 *     cursor. It never joins a lead, a contact, a company or a message. That is
 *     also why `PlanCandidate.evidence` is handed zeroes below: the saturation
 *     signal is a count of leads, and counting leads here would break this rule.
 *  2. Every row carries its own `workspace_id`, and every write downstream is
 *     keyed by that value — never by a workspace the request named. A cursor row
 *     whose `workspace_id` disagrees with its campaign's is dropped here rather
 *     than read across the boundary.
 *  3. The ingest path re-resolves the workspace from `campaign_id` itself, so a
 *     wrong campaign id in a plan item writes nowhere rather than into the wrong
 *     tenant.
 *
 * It is deliberately not exported through `src/lib/db/queries/`: everything there
 * serves the UI and is workspace-scoped. This is the planner's own read.
 *
 * WHY TWO STATEMENTS AND TWO LOCKS. Read without a lock, two plan requests
 * carrying different idempotency keys both see `last_planned_on = null`, compute
 * the identical window from the identical `position`, and hand n8n the same
 * searches twice — the claim rows do not collide, and the second
 * `ON CONFLICT DO UPDATE` rewrites the same value. Serper is paid twice.
 *
 *  - The campaign rows are locked first, which is what makes two planners queue
 *    rather than interleave, and it covers the campaign that has NO cursor row
 *    yet: there is nothing to lock on the first day of a sweep.
 *  - The cursor rows are then read in a SECOND statement, so its snapshot is
 *    taken after the other transaction committed. Reading them through a join in
 *    the locked statement would return the pre-block snapshot under READ
 *    COMMITTED — the lock would be held and the value still stale.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: it excludes another planner but not the
 * `FOR KEY SHARE` that every lead insert takes on its campaign's row, so a sweep
 * in flight does not block the ingest route it feeds.
 */

export type PlanTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function loadPlanCandidates(
  tx: PlanTransaction,
): Promise<readonly PlanCandidate[]> {
  const campaigns = await tx
    .select({
      campaignId: schema.campaigns.id,
      workspaceId: schema.campaigns.workspaceId,
      target: schema.campaigns.target,
    })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.status, 'running'), isNotNull(schema.campaigns.target)))
    .orderBy(schema.campaigns.id)
    .for('no key update')

  if (campaigns.length === 0) return []

  const cursors = await loadCursors(
    tx,
    campaigns.map((row) => row.campaignId),
    [...new Set(campaigns.map((row) => row.workspaceId))],
  )

  return campaigns.map((row) => {
    const cursor = cursors.get(row.campaignId)
    // A cursor is only this campaign's if it agrees about the workspace. The
    // unique index and the two foreign keys make disagreement impossible to
    // reach through this code; the check is here so that a row planted any
    // other way is ignored instead of deciding where a tenant searches next.
    const owned = cursor !== undefined && cursor.workspaceId === row.workspaceId

    return {
      campaignId: row.campaignId,
      workspaceId: row.workspaceId,
      target: row.target,
      cursor: owned ? cursor.state : null,
      // Ignoring the row is only half the answer. The other half is refusing to
      // plan the campaign at all, because the cursor write that would record the
      // sweep is going to be refused for exactly the same reason.
      //
      // This catches it only when the foreign owner is itself a candidate
      // workspace — `loadCursors` is scoped to those, so a row owned by any
      // other workspace is invisible here. `plan.ts` catches that shape on the
      // write side instead.
      cursorConflict: cursor !== undefined && !owned,
      // No evidence is loaded — see rule 1 above. `classifyTier` reads a zero
      // sample as "hold the current tier", so until the saturation counts are
      // wired a campaign only ever moves on the `lap === 0` rule.
      evidence: { newLast14: 0, mergedLast14: 0 },
    }
  })
}

async function loadCursors(
  tx: PlanTransaction,
  campaignIds: readonly string[],
  workspaceIds: readonly string[],
): Promise<Map<string, { workspaceId: string; state: CursorState }>> {
  const rows = await tx
    .select({
      campaignId: schema.scrapeCursors.campaignId,
      workspaceId: schema.scrapeCursors.workspaceId,
      spaceFingerprint: schema.scrapeCursors.spaceFingerprint,
      spaceSize: schema.scrapeCursors.spaceSize,
      position: schema.scrapeCursors.position,
      lap: schema.scrapeCursors.lap,
      lastPlannedOn: schema.scrapeCursors.lastPlannedOn,
      tier: schema.scrapeCursors.tier,
      tierChangedOn: schema.scrapeCursors.tierChangedOn,
    })
    .from(schema.scrapeCursors)
    .where(
      and(
        inArray(schema.scrapeCursors.campaignId, [...campaignIds]),
        inArray(schema.scrapeCursors.workspaceId, [...workspaceIds]),
      ),
    )
    .for('no key update')

  return new Map(
    rows.map((row) => [
      row.campaignId,
      {
        workspaceId: row.workspaceId,
        state: {
          spaceFingerprint: row.spaceFingerprint,
          spaceSize: row.spaceSize,
          position: row.position,
          lap: row.lap,
          lastPlannedOn: row.lastPlannedOn,
          tier: row.tier,
          tierChangedOn: row.tierChangedOn,
        },
      },
    ]),
  )
}
