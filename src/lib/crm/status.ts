import 'server-only'

import { and, eq } from 'drizzle-orm'

import { db, schema } from '@/lib/db/drizzle'
import { type Result, err, ok } from '@/lib/types/result'

import { type ActivityActor, writeActivity } from './activity'
import { type LeadStatus, type TransitionRefusal, refuseTransition } from './transitions'

/**
 * The only place in the codebase that writes `leads.status`
 * (.claude/rules/outreach.md). Nothing else may — not a route handler, not a
 * server action, not a script.
 *
 * The reason is the audit trail, not tidiness. Rule 10 requires every status change
 * to leave an `activities` row naming its actor. A second writer would eventually
 * skip that row, and the gap would only be noticed when someone needed the history
 * to explain what happened to a customer.
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type TransitionError =
  | { readonly kind: 'lead_not_found' }
  | { readonly kind: 'refused'; readonly reason: TransitionRefusal; readonly from: LeadStatus }

export type TransitionInput = {
  readonly workspaceId: string
  readonly leadId: string
  readonly to: LeadStatus
  readonly actor: ActivityActor
  /** Why, in a form a human reading the trail can use. */
  readonly note?: string
}

/**
 * Moves a lead, writing the paired activity row in the same transaction.
 *
 * `tx` is required. The caller is always already inside a transaction — scoring
 * writes the score and the status together, and half of that landing is worse than
 * neither.
 */
export async function transitionLeadStatus(
  tx: Transaction,
  input: TransitionInput,
): Promise<Result<{ from: LeadStatus; to: LeadStatus }, TransitionError>> {
  // Every query filters workspace_id: Drizzle connects privileged and bypasses RLS
  // (CLAUDE.md rule 6, .claude/rules/data.md).
  const [lead] = await tx
    .select({ status: schema.leads.status })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.id, input.leadId),
        eq(schema.leads.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)

  if (lead === undefined) return err({ kind: 'lead_not_found' })

  const from = lead.status
  const refusal = refuseTransition(from, input.to)
  if (refusal !== null) return err({ kind: 'refused', reason: refusal, from })

  await tx
    .update(schema.leads)
    .set({ status: input.to, updatedAt: new Date() })
    .where(
      and(
        eq(schema.leads.id, input.leadId),
        eq(schema.leads.workspaceId, input.workspaceId),
        // Optimistic guard: if something moved the lead between the read above and
        // this write, the update matches nothing rather than overwriting it.
        eq(schema.leads.status, from),
      ),
    )

  await writeActivity(tx, {
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    type: 'status_changed',
    actor: input.actor,
    payload: { from, to: input.to, ...(input.note === undefined ? {} : { note: input.note }) },
  })

  return ok({ from, to: input.to })
}
