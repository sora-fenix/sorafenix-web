import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { workspaces } from './workspace'

/**
 * Observability for every model call. CLAUDE.md rule 2: all LLM calls go through
 * lib/ai/agent.ts, and each one writes a row here — success or failure.
 */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** qualify | generate_content | classify_reply | enrich_company | ... */
    agent: text('agent').notNull(),
    /** Resolved model id from lib/ai/models.ts, recorded as actually used. */
    model: text('model').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    // numeric, not a float: costs get summed for billing and must not drift.
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),
    ok: boolean('ok').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_runs_workspace_created_idx').on(table.workspaceId, table.createdAt.desc()),
    index('ai_runs_workspace_agent_idx').on(table.workspaceId, table.agent),
  ],
)

export type AiRun = typeof aiRuns.$inferSelect
export type NewAiRun = typeof aiRuns.$inferInsert
