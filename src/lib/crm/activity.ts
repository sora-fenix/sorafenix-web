import 'server-only'

import { sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db/drizzle'

/**
 * The activity trail (CLAUDE.md rule 10).
 *
 * Every change to a lead's status, score or owner writes a row here naming who did
 * it. One helper so the column names and the actor vocabulary are decided once.
 *
 * `writer` is the transaction the caller is already inside. Passing it is not
 * optional plumbing — an audit row that can be committed while the change it
 * describes is rolled back is worse than no audit row, because it is a record of
 * something that did not happen.
 */

export type ActivityActor = 'ai' | 'human' | 'system'

/** `activities.type` is free text; these are the ones this codebase writes. */
export type ActivityType =
  | 'lead_created'
  | 'lead_scored'
  | 'message_drafted'
  | 'status_changed'
  | 'owner_changed'

type Writer = Pick<typeof db, 'insert'>

export type ActivityInput = {
  readonly workspaceId: string
  readonly leadId: string
  readonly type: ActivityType
  readonly actor: ActivityActor
  /** Whatever a human would need to understand the change without the diff. */
  readonly payload?: Record<string, unknown>
  readonly channel?: string
}

export async function writeActivity(writer: Writer, input: ActivityInput): Promise<void> {
  await writer.insert(schema.activities).values({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    type: input.type,
    actor: input.actor,
    payload: input.payload ?? null,
    channel: input.channel ?? null,
    // clock_timestamp(), not the column's default now().
    //
    // now() is the *transaction* timestamp and does not move, so two activity rows
    // written in one transaction — scoring a lead writes `lead_scored` and then
    // `status_changed` — land with byte-identical created_at. The trail then has no
    // recorded order, and the dashboard feed, which sorts by created_at, is free to
    // show the status change before the scoring that caused it.
    //
    // clock_timestamp() advances inside a transaction, so the rows keep the order
    // they were actually written in. Found by tests/integration/qualify.test.ts,
    // which passed twice on a coin flip before it failed.
    createdAt: sql`clock_timestamp()`,
  })
}
