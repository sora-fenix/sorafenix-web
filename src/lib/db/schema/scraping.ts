import { date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { campaigns } from './crm'
import { workspaces } from './workspace'

/**
 * Runtime state for the lead hunter (ADR 0001 §2).
 *
 * Its own file rather than a few more columns on `campaigns`: most campaigns are
 * CSV or manual, have `target = null`, and would carry six permanently-null
 * runtime columns forever. `ai_runs` is the precedent — machine state that a user
 * never edits gets its own file, not a corner of the CRM chain.
 *
 * Dependency direction is workspace ← crm ← scraping, a sibling of outreach.
 * Nothing in crm or outreach imports this.
 */

/** ADR 0001 §3. Assigned by the allocator; the column exists here, the logic does not yet. */
export const scrapeTier = pgEnum('scrape_tier', ['burst', 'steady', 'maintenance'])

/**
 * One row per campaign: where that campaign is in its own search space.
 *
 * `(position, space_fingerprint)` is a single invariant — "this index is only
 * meaningful for this space". Editing the target changes the fingerprint, and the
 * position resets with it, because an index into a space that no longer exists
 * would silently sweep the wrong combinations.
 *
 * Written only by the service-role planner. Its RLS grant is SELECT-only
 * (drizzle/0015_rls_scraping.sql); nothing a user touches writes here.
 */
export const scrapeCursors = pgTable(
  'scrape_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** sha256 of the canonicalised target — lib/scraping/target.ts `fingerprintTarget`. */
    spaceFingerprint: text('space_fingerprint').notNull(),
    spaceSize: integer('space_size').notNull(),
    /** Next index to issue. */
    position: integer('position').notNull().default(0),
    /** Completed full passes. `lap = 0` means the space has never been walked once. */
    lap: integer('lap').notNull().default(0),
    lapStartedOn: date('lap_started_on').notNull(),
    /** Rotation key for the smoother: a campaign squeezed out today goes first tomorrow. */
    lastPlannedOn: date('last_planned_on'),
    tier: scrapeTier('tier').notNull().default('burst'),
    /** So a tier cannot flap — a change is rate-limited against this date. */
    tierChangedOn: date('tier_changed_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('scrape_cursors_campaign_key').on(table.campaignId),
    index('scrape_cursors_workspace_idx').on(table.workspaceId),
  ],
)

export type ScrapeCursor = typeof scrapeCursors.$inferSelect
export type NewScrapeCursor = typeof scrapeCursors.$inferInsert
