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

import { products, workspaces } from './workspace'

/**
 * The CRM core: campaigns and the company → contact → lead chain they produce,
 * plus the audit trail.
 *
 * `campaigns` lives here rather than in outreach.ts on purpose. `leads.campaign_id`
 * points at it and `messages.lead_id` points back at `leads`; putting campaigns on
 * the outreach side would make the module graph circular. Dependency direction is
 * workspace ← crm ← outreach.
 */

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'running',
  'paused',
  'done',
])

export const emailStatus = pgEnum('email_status', [
  'unknown',
  'valid',
  'invalid',
  'bounced',
])

export const leadCategory = pgEnum('lead_category', ['hot', 'warm', 'cold'])

/**
 * docs/SPEC.md §1 — the single source of truth for lead status.
 *
 *   new → qualified → contacted → replied → interested → meeting
 *       → proposal → negotiation → won | lost | do_not_contact
 *
 * Transitions are only made by lib/crm/status.ts. Nothing else writes leads.status.
 */
export const leadStatus = pgEnum('lead_status', [
  'new',
  'qualified',
  'contacted',
  'replied',
  'interested',
  'meeting',
  'proposal',
  'negotiation',
  'won',
  'lost',
  'do_not_contact',
])

export const activityActor = pgEnum('activity_actor', ['ai', 'human', 'system'])

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'set null',
    }),
    /** Target market definition handed to the lead hunter: industry, city, size. */
    target: jsonb('target'),
    status: campaignStatus('status').notNull().default('draft'),
    dailyCap: integer('daily_cap').notNull().default(50),
    /** auth.users(id) — FK added in the hand-written migration. */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('campaigns_workspace_status_idx').on(table.workspaceId, table.status),
  ],
)

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Normalised: no protocol, no www., no path, lowercased. */
    domain: text('domain'),
    website: text('website'),
    industry: text('industry'),
    city: text('city'),
    country: text('country').default('ID'),
    sizeBand: text('size_band'),
    employeeCount: integer('employee_count'),
    description: text('description'),
    source: text('source'),
    sourceUrl: text('source_url'),
    /** Untouched payload as it arrived from n8n, for debugging and re-processing. */
    raw: jsonb('raw'),
    /** Whichever normalised key won during dedupe. See lib/leads/dedupe.ts. */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // SPEC §1: "domain (unique per workspace)". Partial, because a company found
    // by phone alone legitimately has no domain and those must not collide.
    uniqueIndex('companies_workspace_domain_key')
      .on(table.workspaceId, table.domain)
      .where(sql`${table.domain} is not null`),
    index('companies_workspace_dedupe_key_idx').on(table.workspaceId, table.dedupeKey),
    index('companies_workspace_city_idx').on(table.workspaceId, table.city),
  ],
)

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, {
      onDelete: 'cascade',
    }),
    name: text('name'),
    position: text('position'),
    department: text('department'),
    email: text('email'),
    /** E.164, e.g. +628123456789 — what lib/leads/dedupe.ts normalises to. */
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    source: text('source'),
    emailStatus: emailStatus('email_status').notNull().default('unknown'),
    /** Set the moment an opt-out is seen. Checked before every send. */
    optOutAt: timestamp('opt_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('contacts_workspace_email_idx').on(table.workspaceId, table.email),
    index('contacts_workspace_phone_idx').on(table.workspaceId, table.phone),
    index('contacts_company_idx').on(table.companyId),
  ],
)

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),
    companyId: uuid('company_id').references(() => companies.id, {
      onDelete: 'cascade',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    /** Weighted total computed in code, never returned by the model (SPEC §4). */
    score: integer('score'),
    category: leadCategory('category'),
    /** Per factor: { score, weight, evidence }. Six factors, weights from SPEC §4. */
    scoreFactors: jsonb('score_factors'),
    /** 2–3 sentences, Bahasa Indonesia. */
    scoreReason: text('score_reason'),
    status: leadStatus('status').notNull().default('new'),
    /** auth.users(id) — FK added in the hand-written migration. */
    ownerId: uuid('owner_id'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('leads_workspace_status_idx').on(table.workspaceId, table.status),
    // Not workspace-scoped: the follow-up runner sweeps due leads across all
    // workspaces in one pass, then fans out per workspace.
    index('leads_next_action_at_idx').on(table.nextActionAt),
    index('leads_workspace_campaign_idx').on(table.workspaceId, table.campaignId),
    index('leads_workspace_owner_idx').on(table.workspaceId, table.ownerId),
    index('leads_workspace_score_idx').on(table.workspaceId, table.score),
    uniqueIndex('leads_campaign_contact_key')
      .on(table.campaignId, table.contactId)
      .where(sql`${table.campaignId} is not null and ${table.contactId} is not null`),
  ],
)

/**
 * CLAUDE.md rule 10: any change to a lead's status, score or owner writes a row
 * here with the actor that caused it.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    channel: text('channel'),
    payload: jsonb('payload'),
    actor: activityActor('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('activities_workspace_lead_created_idx').on(
      table.workspaceId,
      table.leadId,
      table.createdAt.desc(),
    ),
    index('activities_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt.desc(),
    ),
  ],
)

export type Campaign = typeof campaigns.$inferSelect
export type NewCampaign = typeof campaigns.$inferInsert
export type Company = typeof companies.$inferSelect
export type NewCompany = typeof companies.$inferInsert
export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert
export type Lead = typeof leads.$inferSelect
export type NewLead = typeof leads.$inferInsert
export type Activity = typeof activities.$inferSelect
export type NewActivity = typeof activities.$inferInsert
export type LeadStatus = (typeof leadStatus.enumValues)[number]
export type LeadCategory = (typeof leadCategory.enumValues)[number]
