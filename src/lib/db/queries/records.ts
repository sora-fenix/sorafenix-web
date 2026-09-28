import 'server-only'

import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'

import { db } from '@/lib/db/drizzle'
import {
  campaigns,
  companies,
  contacts,
  integrations,
  knowledgeDocs,
  leads,
  memberships,
  messages,
  products,
  suppressions,
} from '@/lib/db/schema'
import type { LeadStatus, MessageStatus } from '@/lib/db/schema'
import { type Page, type PageRequest, buildPage, clampToTotal } from '@/lib/pagination'

/**
 * Read-only list queries for the module screens.
 *
 * Every one filters by workspace_id explicitly. lib/db/drizzle.ts connects with
 * a BYPASSRLS role, so the database will not catch a missing filter here — the
 * `privileged connection` case in tests/integration/rls.test.ts asserts exactly
 * that, which is why this is the reviewer's job.
 *
 * Every list is paginated: the count runs first, the requested page is clamped to
 * it, and only then are rows fetched. Asking for page 900 of 13 therefore lands on
 * page 13 rather than on a blank table with no way back.
 *
 * Ordering always ends in a unique tiebreaker. Without one, two rows with the same
 * score have no defined order between queries, and the same lead can appear on both
 * page 1 and page 2 while another is never shown at all — 935 of the 1208 scraped
 * leads share the `warm` band, so this is the common case, not an edge case.
 */

/**
 * How many rows the same filter matches.
 *
 * Takes the identical `where` the row query uses, so the count and the page can
 * never describe different sets. Joins are left out on purpose: every list here
 * joins with `leftJoin`, which cannot change the number of base rows, and counting
 * without them keeps the count cheap on a table of 1208 and rising.
 */
async function countWhere(table: PgTable, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(where)
  return row?.n ?? 0
}

// -----------------------------------------------------------------------------
// Leads
// -----------------------------------------------------------------------------

export type LeadRow = {
  id: string
  score: number | null
  category: string | null
  status: LeadStatus
  nextActionAt: Date | null
  lastActivityAt: Date | null
  scoreReason: string | null
  companyName: string | null
  companyCity: string | null
  companyIndustry: string | null
  contactName: string | null
  contactPosition: string | null
  campaignName: string | null
}

export async function listLeads(
  workspaceId: string,
  request: PageRequest,
): Promise<Page<LeadRow>> {
  const where = eq(leads.workspaceId, workspaceId)
  const total = await countWhere(leads, where)
  const scoped = clampToTotal(request, total)

  const rows = await db
    .select({
      id: leads.id,
      score: leads.score,
      category: sql<string | null>`${leads.category}`,
      status: leads.status,
      nextActionAt: leads.nextActionAt,
      lastActivityAt: leads.lastActivityAt,
      scoreReason: leads.scoreReason,
      companyName: companies.name,
      companyCity: companies.city,
      companyIndustry: companies.industry,
      contactName: contacts.name,
      contactPosition: contacts.position,
      campaignName: campaigns.name,
    })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .where(where)
    // `desc` puts NULLs first in Postgres, which would float every unscored lead
    // above the best one. An unscored lead is the least urgent thing on the screen.
    .orderBy(sql`${leads.score} desc nulls last`, asc(leads.id))
    .limit(scoped.pageSize)
    .offset(scoped.offset)

  return buildPage(rows, scoped, total)
}

/**
 * Every lead in the workspace, flattened for the CSV export.
 *
 * Deliberately not the paginated `listLeads`: an export that only contained the
 * page you happened to be looking at would be a quietly wrong file, and "1208
 * prospek" on screen next to a 100-row download is exactly the kind of mismatch
 * nobody checks until it has been sent to someone.
 *
 * Capped rather than unbounded. The whole result is built into one string before
 * it is sent, so the cap is what stands between a large workspace and the server
 * running out of memory. When a workspace outgrows it, this becomes a streamed
 * response, not a bigger number.
 */
export const EXPORT_MAX_ROWS = 20_000

export type LeadExportRow = {
  companyName: string | null
  industry: string | null
  address: string | null
  city: string | null
  rating: number | null
  reviewCount: number | null
  website: string | null
  contactName: string | null
  email: string | null
  phone: string | null
  whatsapp: string | null
  score: number | null
  category: string | null
  status: LeadStatus
  scoreReason: string | null
  campaignName: string | null
  sourceUrl: string | null
  createdAt: Date
}

export async function exportLeads(workspaceId: string): Promise<LeadExportRow[]> {
  return db
    .select({
      companyName: companies.name,
      industry: companies.industry,
      address: companies.address,
      city: companies.city,
      rating: companies.rating,
      reviewCount: companies.reviewCount,
      website: companies.website,
      contactName: contacts.name,
      email: contacts.email,
      phone: contacts.phone,
      whatsapp: contacts.whatsapp,
      score: leads.score,
      category: sql<string | null>`${leads.category}`,
      status: leads.status,
      scoreReason: leads.scoreReason,
      campaignName: campaigns.name,
      sourceUrl: companies.sourceUrl,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .where(eq(leads.workspaceId, workspaceId))
    .orderBy(sql`${leads.score} desc nulls last`, asc(leads.id))
    .limit(EXPORT_MAX_ROWS)
}

// -----------------------------------------------------------------------------
// Companies
// -----------------------------------------------------------------------------

export type CompanyRow = {
  id: string
  name: string
  domain: string | null
  industry: string | null
  address: string | null
  city: string | null
  rating: number | null
  reviewCount: number | null
  sizeBand: string | null
  employeeCount: number | null
  source: string | null
  contactCount: number
}

export async function listCompanies(
  workspaceId: string,
  request: PageRequest,
): Promise<Page<CompanyRow>> {
  const where = eq(companies.workspaceId, workspaceId)
  const total = await countWhere(companies, where)
  const scoped = clampToTotal(request, total)

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      industry: companies.industry,
      address: companies.address,
      city: companies.city,
      rating: companies.rating,
      reviewCount: companies.reviewCount,
      sizeBand: companies.sizeBand,
      employeeCount: companies.employeeCount,
      source: companies.source,
      contactCount: sql<number>`(
        select count(*)::int from ${contacts}
        where ${contacts.companyId} = ${companies.id}
      )`,
    })
    .from(companies)
    .where(where)
    .orderBy(asc(companies.name), asc(companies.id))
    .limit(scoped.pageSize)
    .offset(scoped.offset)

  return buildPage(rows, scoped, total)
}

// -----------------------------------------------------------------------------
// Contacts
// -----------------------------------------------------------------------------

export type ContactRow = {
  id: string
  name: string | null
  position: string | null
  email: string | null
  phone: string | null
  emailStatus: string
  optOutAt: Date | null
  companyName: string | null
  companyCity: string | null
}

export async function listContacts(
  workspaceId: string,
  request: PageRequest,
): Promise<Page<ContactRow>> {
  const where = eq(contacts.workspaceId, workspaceId)
  const total = await countWhere(contacts, where)
  const scoped = clampToTotal(request, total)

  const rows = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      position: contacts.position,
      email: contacts.email,
      phone: contacts.phone,
      emailStatus: sql<string>`${contacts.emailStatus}`,
      optOutAt: contacts.optOutAt,
      companyName: companies.name,
      companyCity: companies.city,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(where)
    // Scraped contacts have no name yet — enrichment fills it — so they sort last
    // rather than filling the first page with blanks.
    .orderBy(sql`${contacts.name} asc nulls last`, asc(contacts.id))
    .limit(scoped.pageSize)
    .offset(scoped.offset)

  return buildPage(rows, scoped, total)
}

// -----------------------------------------------------------------------------
// Campaigns
// -----------------------------------------------------------------------------

export type CampaignRow = {
  id: string
  name: string
  status: string
  dailyCap: number
  createdAt: Date
  productName: string | null
  leadCount: number
}

export async function listCampaigns(
  workspaceId: string,
  request: PageRequest,
): Promise<Page<CampaignRow>> {
  const where = eq(campaigns.workspaceId, workspaceId)
  const total = await countWhere(campaigns, where)
  const scoped = clampToTotal(request, total)

  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: sql<string>`${campaigns.status}`,
      dailyCap: campaigns.dailyCap,
      createdAt: campaigns.createdAt,
      productName: products.name,
      leadCount: sql<number>`(
        select count(*)::int from ${leads} where ${leads.campaignId} = ${campaigns.id}
      )`,
    })
    .from(campaigns)
    .leftJoin(products, eq(products.id, campaigns.productId))
    .where(where)
    .orderBy(desc(campaigns.createdAt), asc(campaigns.id))
    .limit(scoped.pageSize)
    .offset(scoped.offset)

  return buildPage(rows, scoped, total)
}

export type CampaignOption = { id: string; name: string }

/**
 * Every campaign in the workspace, for a picker.
 *
 * Unpaginated and two columns wide, unlike `listCampaigns`: a `<select>` that
 * only offered the first page would silently hide the campaign the user wants.
 * A workspace has campaigns in the tens, not the thousands.
 */
export async function listCampaignOptions(workspaceId: string): Promise<CampaignOption[]> {
  return db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(asc(campaigns.name), asc(campaigns.id))
}

// -----------------------------------------------------------------------------
// Messages — inbox and approvals
// -----------------------------------------------------------------------------

export type MessageRow = {
  id: string
  channel: string
  status: MessageStatus
  subject: string | null
  body: string | null
  sentAt: Date | null
  createdAt: Date
  companyName: string | null
  contactName: string | null
}

/**
 * The `on` conditions from a message out to its lead, company and contact.
 *
 * Each carries `workspace_id` equality as well as the id. The foreign key
 * guarantees the child row exists; it says nothing about which tenant owns it,
 * and there is no composite FK on `(workspace_id, id)`, no CHECK and no trigger
 * tying a child's workspace to its parent's. Without these the isolation of
 * `listInbox` and `listApprovals` rests on every writer having been correct —
 * so the condition is written down and the planner enforces it instead.
 *
 * Constants rather than a helper function: Drizzle's builder type changes with
 * every join, so a wrapper would need a type assertion, and rule 9 forbids one.
 */
const MESSAGE_LEAD_ON = and(
  eq(leads.id, messages.leadId),
  eq(leads.workspaceId, messages.workspaceId),
)
const MESSAGE_COMPANY_ON = and(
  eq(companies.id, leads.companyId),
  eq(companies.workspaceId, messages.workspaceId),
)
const MESSAGE_CONTACT_ON = and(
  eq(contacts.id, leads.contactId),
  eq(contacts.workspaceId, messages.workspaceId),
)

function messageSelection() {
  return {
    id: messages.id,
    channel: sql<string>`${messages.channel}`,
    status: messages.status,
    subject: messages.subject,
    body: messages.body,
    sentAt: messages.sentAt,
    createdAt: messages.createdAt,
    companyName: companies.name,
    contactName: contacts.name,
  }
}

/** Inbound replies, newest first. */
export async function listInbox(
  workspaceId: string,
  request: PageRequest,
): Promise<Page<MessageRow>> {
  const where = and(eq(messages.workspaceId, workspaceId), eq(messages.direction, 'in'))
  const total = await countWhere(messages, where)
  const scoped = clampToTotal(request, total)

  const rows = await db
    .select(messageSelection())
    .from(messages)
    .leftJoin(leads, MESSAGE_LEAD_ON)
    .leftJoin(companies, MESSAGE_COMPANY_ON)
    .leftJoin(contacts, MESSAGE_CONTACT_ON)
    .where(where)
    .orderBy(sql`${messages.sentAt} desc nulls last`, desc(messages.createdAt), asc(messages.id))
    .limit(scoped.pageSize)
    .offset(scoped.offset)

  return buildPage(rows, scoped, total)
}

/**
 * A draft plus where its contact came from.
 *
 * The provenance is on the approval screen and not only on the contact record
 * because this is the last human checkpoint before a message goes out. A contact
 * that arrived on a spreadsheet somebody uploaded carries a different obligation
 * from one the scraper found on a public business listing, and the person
 * clicking approve is the one who has to know which they are looking at
 * (`.claude/rules/outreach.md`, "who we are allowed to contact").
 */
export type ApprovalRow = MessageRow & { contactSource: string | null }

/**
 * The approval queue. `needs_input` first: those are drafts the AI could not
 * complete from knowledge_docs and which must never be sent as-is
 * (CLAUDE.md rule 3).
 */
export async function listApprovals(
  workspaceId: string,
  request: PageRequest,
): Promise<Page<ApprovalRow>> {
  const where = and(
    eq(messages.workspaceId, workspaceId),
    inArray(messages.status, ['needs_input', 'pending_approval']),
  )
  const total = await countWhere(messages, where)
  const scoped = clampToTotal(request, total)

  const rows = await db
    .select({ ...messageSelection(), contactSource: contacts.source })
    .from(messages)
    .leftJoin(leads, MESSAGE_LEAD_ON)
    .leftJoin(companies, MESSAGE_COMPANY_ON)
    .leftJoin(contacts, MESSAGE_CONTACT_ON)
    .where(where)
    .orderBy(
      sql`case when ${messages.status} = 'needs_input' then 0 else 1 end`,
      desc(messages.createdAt),
      asc(messages.id),
    )
    .limit(scoped.pageSize)
    .offset(scoped.offset)

  return buildPage(rows, scoped, total)
}

// -----------------------------------------------------------------------------
// Knowledge base
// -----------------------------------------------------------------------------

export type KnowledgeDocRow = {
  id: string
  type: string
  title: string
  content: string | null
  isActive: boolean
  updatedAt: Date
}

export async function listKnowledgeDocs(workspaceId: string): Promise<KnowledgeDocRow[]> {
  return db
    .select({
      id: knowledgeDocs.id,
      type: sql<string>`${knowledgeDocs.type}`,
      title: knowledgeDocs.title,
      content: knowledgeDocs.content,
      isActive: knowledgeDocs.isActive,
      updatedAt: knowledgeDocs.updatedAt,
    })
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.workspaceId, workspaceId))
    .orderBy(knowledgeDocs.type)
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

export type MemberRow = { id: string; role: string; userId: string }
export type IntegrationRow = { id: string; provider: string; status: string; meta: unknown }
export type SuppressionRow = { id: string; kind: string; value: string; reason: string | null }

export async function listMembers(workspaceId: string): Promise<MemberRow[]> {
  return db
    .select({
      id: memberships.id,
      role: sql<string>`${memberships.role}`,
      userId: memberships.userId,
    })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(memberships.role)
}

export async function listIntegrations(workspaceId: string): Promise<IntegrationRow[]> {
  return db
    .select({
      id: integrations.id,
      provider: sql<string>`${integrations.provider}`,
      status: sql<string>`${integrations.status}`,
      meta: integrations.meta,
    })
    .from(integrations)
    .where(eq(integrations.workspaceId, workspaceId))
    .orderBy(integrations.provider)
}

export async function listSuppressions(workspaceId: string): Promise<SuppressionRow[]> {
  return db
    .select({
      id: suppressions.id,
      kind: sql<string>`${suppressions.kind}`,
      value: suppressions.value,
      reason: suppressions.reason,
    })
    .from(suppressions)
    .where(eq(suppressions.workspaceId, workspaceId))
    .orderBy(suppressions.kind, suppressions.value)
}

export async function countProducts(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(products)
    .where(eq(products.workspaceId, workspaceId))
  return row?.n ?? 0
}
