import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Foundation schema only — workspaces and memberships.
 *
 * Domain tables (companies, contacts, leads, messages, sequence_runs, activities,
 * suppressions, ai_runs, integrations, webhook_events) are specified in
 * docs/SPEC.md §1 and land in their own vertical slices. Do not add them here
 * ahead of the slice that needs them.
 */

export const membershipRole = pgEnum('membership_role', [
  'owner',
  'manager',
  'sales',
  'viewer',
])

export const workspacePlan = pgEnum('workspace_plan', ['free', 'pro', 'business'])

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    plan: workspacePlan('plan').notNull().default('free'),
    dailyEmailLimit: integer('daily_email_limit').notNull().default(200),
    dailyWaLimit: integer('daily_wa_limit').notNull().default(100),
    // Ships false and is not wired to skip approval in MVP (CLAUDE.md rule 5).
    autonomousMode: boolean('autonomous_mode').notNull().default(false),
    // IANA name. Drives quiet-hours checks in lib/outreach/send-guard.ts later.
    timezone: text('timezone').notNull().default('Asia/Jakarta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspaces_slug_key').on(table.slug)],
)

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // References auth.users(id), which Supabase owns. The foreign key is added in
    // the hand-written migration rather than declared here, so drizzle-kit never
    // tries to create or drop anything in the `auth` schema.
    userId: uuid('user_id').notNull(),
    role: membershipRole('role').notNull().default('sales'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_key').on(table.workspaceId, table.userId),
  ],
)

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type Membership = typeof memberships.$inferSelect
export type NewMembership = typeof memberships.$inferInsert
