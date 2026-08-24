import {
  boolean,
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

/**
 * Workspace-level configuration: the tenant itself, who belongs to it, what it
 * sells, what the AI is allowed to say, and which providers are connected.
 *
 * This file is the root of the schema dependency graph — it imports nothing from
 * the other domain files. See lib/db/schema/index.ts for the ordering rule.
 */

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

export const membershipRole = pgEnum('membership_role', [
  'owner',
  'manager',
  'sales',
  'viewer',
])

export const workspacePlan = pgEnum('workspace_plan', ['free', 'pro', 'business'])

/** docs/SPEC.md §1 — knowledge_docs.type */
export const knowledgeDocType = pgEnum('knowledge_doc_type', [
  'company_profile',
  'catalog',
  'pricelist',
  'faq',
  'case_study',
  'script',
  'objection',
  'tnc',
])

/** docs/SPEC.md §1 — integrations.provider */
export const integrationProvider = pgEnum('integration_provider', [
  'gmail',
  'whatsapp',
  'serper',
])

/**
 * SPEC leaves integrations.status un-enumerated. These three are what the
 * settings screen needs to render; extend when OAuth refresh lands.
 */
export const integrationStatus = pgEnum('integration_status', [
  'connected',
  'disconnected',
  'error',
])

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

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
    // a hand-written migration rather than declared here, so drizzle-kit never
    // tries to create or drop anything in the `auth` schema.
    userId: uuid('user_id').notNull(),
    role: membershipRole('role').notNull().default('sales'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_key').on(table.workspaceId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
)

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    valueProp: text('value_prop'),
    /** Ideal customer profile: industries, size bands, cities, pain points. */
    icp: jsonb('icp'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('products_workspace_idx').on(table.workspaceId)],
)

/**
 * The only source of facts the AI may quote (CLAUDE.md rule 3). If a claim is not
 * verbatim-supported here, the draft is flagged needs_input rather than guessed.
 */
export const knowledgeDocs = pgTable(
  'knowledge_docs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: knowledgeDocType('type').notNull(),
    title: text('title').notNull(),
    content: text('content'),
    fileUrl: text('file_url'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_docs_workspace_type_idx').on(table.workspaceId, table.type),
  ],
)

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: integrationProvider('provider').notNull(),
    /** Encrypted at the application layer. Never selected into a client component. */
    credentialsEncrypted: text('credentials_encrypted'),
    status: integrationStatus('status').notNull().default('disconnected'),
    /** Non-secret provider metadata: connected account, phone number id, scopes. */
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('integrations_workspace_provider_key').on(
      table.workspaceId,
      table.provider,
    ),
  ],
)

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type Membership = typeof memberships.$inferSelect
export type NewMembership = typeof memberships.$inferInsert
export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert
export type KnowledgeDoc = typeof knowledgeDocs.$inferSelect
export type NewKnowledgeDoc = typeof knowledgeDocs.$inferInsert
export type Integration = typeof integrations.$inferSelect
export type NewIntegration = typeof integrations.$inferInsert
