import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { leads } from './crm'
import { workspaces } from './workspace'

/**
 * Everything on the sending side: the messages themselves, the follow-up state
 * machine, the suppression list that gates every send, and the webhook receipts
 * that make replays safe.
 */

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

export const messageChannel = pgEnum('message_channel', ['email', 'whatsapp'])

export const messageDirection = pgEnum('message_direction', ['out', 'in'])

/** docs/SPEC.md §1 — messages.status */
export const messageStatus = pgEnum('message_status', [
  'draft',
  'needs_input',
  'pending_approval',
  'approved',
  'queued',
  'sent',
  'delivered',
  'opened',
  'replied',
  'bounced',
  'failed',
  'rejected',
])

export const sequenceState = pgEnum('sequence_state', ['active', 'paused', 'stopped'])

export const suppressionKind = pgEnum('suppression_kind', ['email', 'phone', 'domain'])

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    channel: messageChannel('channel').notNull(),
    direction: messageDirection('direction').notNull(),
    status: messageStatus('status').notNull().default('draft'),
    subject: text('subject'),
    body: text('body'),
    /** Approved WhatsApp Cloud API template name, for first contact. */
    templateId: text('template_id'),
    providerMessageId: text('provider_message_id'),
    /** Groups a conversation. Gmail thread id, or the WhatsApp wa_id. */
    threadId: text('thread_id'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** auth.users(id) — FK added in the hand-written migration. */
    approvedBy: uuid('approved_by'),
    rejectReason: text('reject_reason'),
    /** CLAUDE.md rule 7: every send is safe to replay. */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('messages_workspace_idempotency_key')
      .on(table.workspaceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('messages_workspace_status_idx').on(table.workspaceId, table.status),
    index('messages_workspace_lead_created_idx').on(
      table.workspaceId,
      table.leadId,
      table.createdAt.desc(),
    ),
    index('messages_thread_idx').on(table.threadId),
    index('messages_provider_message_idx').on(table.providerMessageId),
  ],
)

/**
 * One row per lead per sequence. lib/sequences/state-machine.ts computes the next
 * step as a pure function; this table is only the persisted position.
 */
export const sequenceRuns = pgTable(
  'sequence_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    /** No sequences table in MVP; the default sequence is defined in code. */
    sequenceId: text('sequence_id').notNull().default('default'),
    currentStep: integer('current_step').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    state: sequenceState('state').notNull().default('active'),
    /** replied | opted_out | meeting_booked | bounced | campaign_paused | ... */
    stopReason: text('stop_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The runner claims due rows with FOR UPDATE SKIP LOCKED every 5 minutes.
    // Partial, because stopped and paused runs are the overwhelming majority
    // over time and must not bloat the index the hot path scans.
    index('sequence_runs_due_idx')
      .on(table.nextRunAt)
      .where(sql`${table.state} = 'active'`),
    uniqueIndex('sequence_runs_lead_sequence_key').on(table.leadId, table.sequenceId),
    index('sequence_runs_workspace_state_idx').on(table.workspaceId, table.state),
  ],
)

/**
 * Checked before EVERY send, not just at campaign build time (CLAUDE.md §6).
 * A "STOP" / "jangan hubungi lagi" reply writes here immediately.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: suppressionKind('kind').notNull(),
    /** Normalised before insert: lowercased email, E.164 phone, bare domain. */
    value: text('value').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('suppressions_workspace_kind_value_key').on(
      table.workspaceId,
      table.kind,
      table.value,
    ),
  ],
)

/** CLAUDE.md rule 7: handled keys are stored so replays are no-ops. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Globally unique per provider, not per workspace: an inbound webhook is
    // deduped before we know which workspace it belongs to.
    uniqueIndex('webhook_events_provider_idempotency_key').on(
      table.provider,
      table.idempotencyKey,
    ),
    index('webhook_events_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
  ],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type SequenceRun = typeof sequenceRuns.$inferSelect
export type NewSequenceRun = typeof sequenceRuns.$inferInsert
export type Suppression = typeof suppressions.$inferSelect
export type NewSuppression = typeof suppressions.$inferInsert
export type WebhookEvent = typeof webhookEvents.$inferSelect
export type NewWebhookEvent = typeof webhookEvents.$inferInsert
export type MessageStatus = (typeof messageStatus.enumValues)[number]
