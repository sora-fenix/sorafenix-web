import 'server-only'

import { and, eq, isNull, or, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db/drizzle'

import {
  type CompanyLookup,
  type NormalizedLead,
  type RawLead,
  dedupeKeyFor,
  findDuplicate,
  isContactable,
  normalizeLead,
} from './dedupe'

/**
 * Lead ingestion (SPEC §2). One batch, one transaction.
 *
 * Everything here runs against the Drizzle handle, which bypasses RLS — so every
 * single query below filters on `workspace_id`, without exception. That is the
 * rule this file exists to obey (CLAUDE.md rule 6).
 *
 * The batch is transactional for a reason beyond tidiness: dedupe reads the rows
 * the same batch has already written. Two identical items in one payload resolve
 * against each other, not against nothing, so a payload that lists the same shop
 * twice inserts it once.
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type IngestItem = RawLead & {
  /** The untouched payload item, kept for debugging and re-processing. */
  raw: unknown
}

export type RejectionReason = 'company_name_missing' | 'no_contact_channel'

export type RejectedItem = {
  index: number
  reason: RejectionReason
}

export type IngestResult = {
  accepted: number
  inserted: number
  duplicates: number
  rejected: RejectedItem[]
}

export type IngestInput = {
  workspaceId: string
  campaignId: string
  source: string
  items: readonly IngestItem[]
}

// -----------------------------------------------------------------------------
// Rejection — pure, and reusable on replay
// -----------------------------------------------------------------------------

/**
 * SPEC §2's reject rule, applied before anything touches the database.
 *
 * Split out because a replayed webhook must report the same rejections as the
 * original delivery without repeating any of its writes. Same input, same
 * verdict, no I/O.
 */
export function rejectionFor(lead: NormalizedLead): RejectionReason | null {
  if (lead.companyName === '') return 'company_name_missing'
  if (!isContactable(lead)) return 'no_contact_channel'
  return null
}

export function rejectionsFor(items: readonly IngestItem[]): RejectedItem[] {
  const rejected: RejectedItem[] = []
  items.forEach((item, index) => {
    const reason = rejectionFor(normalizeLead(item))
    if (reason !== null) rejected.push({ index, reason })
  })
  return rejected
}

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

/** Narrows one column of an untyped row without a type assertion. */
function stringColumn(row: Record<string, unknown> | undefined, column: string): string | null {
  if (row === undefined) return null
  const value = row[column]
  return typeof value === 'string' ? value : null
}

/**
 * The database-backed half of dedupe. Every method filters by workspace.
 *
 * Phones and emails live on `contacts`, not `companies`, so those two strategies
 * reach the company through its contacts. A contact with no company is skipped
 * rather than treated as a match — it cannot tell us which company this is.
 */
function createLookup(tx: Transaction, workspaceId: string): CompanyLookup {
  return {
    async byDomain(domain) {
      const rows = await tx
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.workspaceId, workspaceId),
            eq(schema.companies.domain, domain),
          ),
        )
        .limit(1)
      return rows[0]?.id ?? null
    },

    async byPhone(phone) {
      const rows = await tx
        .select({ companyId: schema.contacts.companyId })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.workspaceId, workspaceId),
            or(eq(schema.contacts.phone, phone), eq(schema.contacts.whatsapp, phone)),
          ),
        )
        .limit(1)
      return rows[0]?.companyId ?? null
    },

    async byEmail(email) {
      const rows = await tx
        .select({ companyId: schema.contacts.companyId })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.workspaceId, workspaceId),
            eq(schema.contacts.email, email),
          ),
        )
        .limit(1)
      return rows[0]?.companyId ?? null
    },

    async byFuzzyNameCity(comparableName, comparableCity, threshold) {
      // sora_name_similarity pins its own search_path — see drizzle/0005_pg_trgm.sql.
      // City is compared with lower(trim(...)) rather than our full city
      // normaliser, which SQL cannot run; the two agree on every city we store.
      const rows = await tx.execute(sql`
        select id
        from companies
        where workspace_id = ${workspaceId}
          and name_normalized is not null
          and lower(trim(city)) = ${comparableCity}
          and public.sora_name_similarity(name_normalized, ${comparableName}) >= ${threshold}
        order by public.sora_name_similarity(name_normalized, ${comparableName}) desc
        limit 1
      `)
      return stringColumn(rows[0], 'id')
    },
  }
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

async function insertNewLead(
  tx: Transaction,
  input: IngestInput,
  lead: NormalizedLead,
  raw: unknown,
): Promise<void> {
  const [company] = await tx
    .insert(schema.companies)
    .values({
      workspaceId: input.workspaceId,
      name: lead.companyName,
      nameNormalized: lead.comparableName === '' ? null : lead.comparableName,
      domain: lead.domain,
      website: lead.website,
      industry: lead.category,
      city: lead.city,
      source: input.source,
      sourceUrl: lead.sourceUrl,
      raw: sql`${JSON.stringify(raw)}::jsonb`,
      dedupeKey: dedupeKeyFor(lead),
    })
    .returning({ id: schema.companies.id })

  if (company === undefined) throw new Error('company insert returned no row')

  // n8n's place search yields a business, not a person: there is no contact name
  // yet. The row still earns its place — it is what holds the reachable channels,
  // and enrichment fills the name in later.
  const [contact] = await tx
    .insert(schema.contacts)
    .values({
      workspaceId: input.workspaceId,
      companyId: company.id,
      email: lead.email,
      phone: lead.phone,
      whatsapp: lead.whatsapp,
      source: input.source,
    })
    .returning({ id: schema.contacts.id })

  if (contact === undefined) throw new Error('contact insert returned no row')

  const [insertedLead] = await tx
    .insert(schema.leads)
    .values({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      companyId: company.id,
      contactId: contact.id,
      status: 'new',
    })
    .returning({ id: schema.leads.id })

  if (insertedLead === undefined) throw new Error('lead insert returned no row')

  await tx.insert(schema.activities).values({
    workspaceId: input.workspaceId,
    leadId: insertedLead.id,
    type: 'lead_created',
    channel: input.source,
    actor: 'system',
    payload: { source: input.source, campaign_id: input.campaignId },
  })
}

/**
 * SPEC §2 on a duplicate: do not insert, merge newly-found fields, log an activity.
 *
 * Merge means **fill blanks only**. An incoming value never overwrites something
 * already stored: the existing row may carry a correction a human made by hand,
 * and a scraper re-running tomorrow must not silently undo it.
 */
async function mergeIntoExisting(
  tx: Transaction,
  input: IngestInput,
  companyId: string,
  lead: NormalizedLead,
  strategy: string,
  matchedOn: string,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(schema.companies)
    .where(
      and(
        eq(schema.companies.workspaceId, input.workspaceId),
        eq(schema.companies.id, companyId),
      ),
    )
    .limit(1)

  if (existing === undefined) return

  const filled: Partial<typeof schema.companies.$inferInsert> = {}
  if (existing.domain === null && lead.domain !== null) filled.domain = lead.domain
  if (existing.website === null && lead.website !== null) filled.website = lead.website
  if (existing.city === null && lead.city !== null) filled.city = lead.city
  if (existing.industry === null && lead.category !== null) filled.industry = lead.category
  if (existing.sourceUrl === null && lead.sourceUrl !== null) {
    filled.sourceUrl = lead.sourceUrl
  }
  if (existing.nameNormalized === null && lead.comparableName !== '') {
    filled.nameNormalized = lead.comparableName
  }

  if (Object.keys(filled).length > 0) {
    await tx
      .update(schema.companies)
      .set({ ...filled, updatedAt: new Date() })
      .where(
        and(
          eq(schema.companies.workspaceId, input.workspaceId),
          eq(schema.companies.id, companyId),
        ),
      )
  }

  // A channel we did not have before is the most valuable thing a re-import
  // brings, so fill it onto a contact that is missing it.
  if (lead.email !== null || lead.phone !== null || lead.whatsapp !== null) {
    const [contact] = await tx
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.workspaceId, input.workspaceId),
          eq(schema.contacts.companyId, companyId),
        ),
      )
      .limit(1)

    if (contact !== undefined) {
      const contactFill: Partial<typeof schema.contacts.$inferInsert> = {}
      if (contact.email === null && lead.email !== null) contactFill.email = lead.email
      if (contact.phone === null && lead.phone !== null) contactFill.phone = lead.phone
      if (contact.whatsapp === null && lead.whatsapp !== null) {
        contactFill.whatsapp = lead.whatsapp
      }
      if (Object.keys(contactFill).length > 0) {
        await tx
          .update(schema.contacts)
          .set({ ...contactFill, updatedAt: new Date() })
          .where(
            and(
              eq(schema.contacts.workspaceId, input.workspaceId),
              eq(schema.contacts.id, contact.id),
            ),
          )
      }
    }
  }

  // Rule 10: the audit row hangs off the lead when there is one. A company with
  // no lead yet still gets the activity, with a null lead_id.
  const [existingLead] = await tx
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.workspaceId, input.workspaceId),
        eq(schema.leads.companyId, companyId),
      ),
    )
    .limit(1)

  await tx.insert(schema.activities).values({
    workspaceId: input.workspaceId,
    leadId: existingLead?.id ?? null,
    type: 'lead_duplicate_merged',
    channel: input.source,
    actor: 'system',
    payload: {
      source: input.source,
      strategy,
      matched_on: matchedOn,
      fields_filled: Object.keys(filled),
    },
  })
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/**
 * Ingests one batch. Returns the counts the webhook reports back to the caller.
 *
 * Runs inside `tx`, which the caller opens — the webhook route puts the
 * `webhook_events` insert in the same transaction, so an idempotency key is only
 * ever recorded together with the rows it produced.
 */
export async function ingestLeads(
  tx: Transaction,
  input: IngestInput,
): Promise<IngestResult> {
  const lookup = createLookup(tx, input.workspaceId)
  const rejected: RejectedItem[] = []
  let inserted = 0
  let duplicates = 0

  for (const [index, item] of input.items.entries()) {
    const lead = normalizeLead(item)

    const reason = rejectionFor(lead)
    if (reason !== null) {
      rejected.push({ index, reason })
      continue
    }

    const match = await findDuplicate(lookup, lead)
    if (match !== null) {
      await mergeIntoExisting(
        tx,
        input,
        match.companyId,
        lead,
        match.strategy,
        match.matchedOn,
      )
      duplicates += 1
      continue
    }

    await insertNewLead(tx, input, lead, item.raw)
    inserted += 1
  }

  return { accepted: input.items.length, inserted, duplicates, rejected }
}

/**
 * Backfills `name_normalized` for rows written before the column existed, so
 * fuzzy matching can see them. Idempotent, workspace-scoped, and safe to re-run.
 */
export async function backfillNormalizedNames(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.companies.id, name: schema.companies.name })
    .from(schema.companies)
    .where(
      and(
        eq(schema.companies.workspaceId, workspaceId),
        isNull(schema.companies.nameNormalized),
      ),
    )

  for (const row of rows) {
    const comparable = normalizeLead({ companyName: row.name }).comparableName
    if (comparable === '') continue
    await db
      .update(schema.companies)
      .set({ nameNormalized: comparable })
      .where(
        and(
          eq(schema.companies.workspaceId, workspaceId),
          eq(schema.companies.id, row.id),
        ),
      )
  }

  return rows.length
}
