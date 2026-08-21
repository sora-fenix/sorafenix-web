import 'server-only'

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'

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

/**
 * Read-only list queries for the module screens.
 *
 * Every one filters by workspace_id explicitly. lib/db/drizzle.ts connects with
 * a BYPASSRLS role, so the database will not catch a missing filter here — the
 * `privileged connection` case in tests/integration/rls.test.ts asserts exactly
 * that, which is why this is the reviewer's job.
 *
 * A fixed LIMIT stands in for pagination, which arrives with the slice that
 * makes these screens interactive.
 */

const PAGE_SIZE = 100

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

export async function listLeads(workspaceId: string): Promise<LeadRow[]> {
  return db
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
    .where(eq(leads.workspaceId, workspaceId))
    .orderBy(desc(leads.score))
    .limit(PAGE_SIZE)
}

// -----------------------------------------------------------------------------
// Companies
// -----------------------------------------------------------------------------

export type CompanyRow = {
  id: string
  name: string
  domain: string | null
  industry: string | null
  city: string | null
  sizeBand: string | null
  employeeCount: number | null
  source: string | null
  contactCount: number
}

export async function listCompanies(workspaceId: string): Promise<CompanyRow[]> {
  return db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      industry: companies.industry,
      city: companies.city,
      sizeBand: companies.sizeBand,
      employeeCount: companies.employeeCount,
      source: companies.source,
      contactCount: sql<number>`(
        select count(*)::int from ${contacts}
        where ${contacts.companyId} = ${companies.id}
      )`,
    })
    .from(companies)
    .where(eq(companies.workspaceId, workspaceId))
    .orderBy(companies.name)
    .limit(PAGE_SIZE)
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

export async function listContacts(workspaceId: string): Promise<ContactRow[]> {
  return db
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
    .where(eq(contacts.workspaceId, workspaceId))
    .orderBy(contacts.name)
    .limit(PAGE_SIZE)
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

export async function listCampaigns(workspaceId: string): Promise<CampaignRow[]> {
  return db
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
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(desc(campaigns.createdAt))
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
export async function listInbox(workspaceId: string): Promise<MessageRow[]> {
  return db
    .select(messageSelection())
    .from(messages)
    .leftJoin(leads, eq(leads.id, messages.leadId))
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.direction, 'in')))
    .orderBy(desc(messages.sentAt))
    .limit(PAGE_SIZE)
}

/**
 * The approval queue. `needs_input` first: those are drafts the AI could not
 * complete from knowledge_docs and which must never be sent as-is
 * (CLAUDE.md rule 3).
 */
export async function listApprovals(workspaceId: string): Promise<MessageRow[]> {
  return db
    .select(messageSelection())
    .from(messages)
    .leftJoin(leads, eq(leads.id, messages.leadId))
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        inArray(messages.status, ['needs_input', 'pending_approval']),
      ),
    )
    .orderBy(sql`case when ${messages.status} = 'needs_input' then 0 else 1 end`, desc(messages.createdAt))
    .limit(PAGE_SIZE)
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
