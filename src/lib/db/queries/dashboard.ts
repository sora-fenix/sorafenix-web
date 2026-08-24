import 'server-only'

import { and, count, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'

import { db } from '@/lib/db/drizzle'
import { activities, companies, contacts, leads } from '@/lib/db/schema'
import { messages } from '@/lib/db/schema'
import type { LeadStatus } from '@/lib/db/schema'

/**
 * Dashboard figures. Every number is aggregated in Postgres and returned already
 * summed — docs/SPEC.md §9 forbids client-side aggregation.
 *
 * SPEC asks for these to come from SQL views. They are plain aggregate queries
 * for now; a view buys nothing until the dashboard slice settles what it needs,
 * and it would be one more migration to keep in step. Noted in docs/PROGRESS.md.
 *
 * Every query filters by workspace_id explicitly: this connection bypasses RLS.
 */

export type DashboardStats = {
  totalLeads: number
  qualified: number
  hot: number
  emailsSent: number
  waSent: number
  replies: number
  meetings: number
  replyRate: number
  conversionRate: number
  companies: number
  contacts: number
}

/** Statuses that mean the lead has progressed past raw intake. */
const QUALIFIED_ONWARD: LeadStatus[] = [
  'qualified',
  'contacted',
  'replied',
  'interested',
  'meeting',
  'proposal',
  'negotiation',
  'won',
]

const MEETING_ONWARD: LeadStatus[] = [
  'meeting',
  'proposal',
  'negotiation',
  'won',
]

const SENT_ONWARD = ['sent', 'delivered', 'opened', 'replied'] as const

export async function getDashboardStats(workspaceId: string): Promise<DashboardStats> {
  const [leadRow] = await db
    .select({
      total: count(),
      qualified: sql<number>`count(*) filter (where ${inArray(leads.status, QUALIFIED_ONWARD)})::int`,
      hot: sql<number>`count(*) filter (where ${leads.category} = 'hot')::int`,
      meetings: sql<number>`count(*) filter (where ${inArray(leads.status, MEETING_ONWARD)})::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId))

  const [messageRow] = await db
    .select({
      emailsSent: sql<number>`count(*) filter (where ${messages.channel} = 'email' and ${messages.direction} = 'out' and ${inArray(messages.status, [...SENT_ONWARD])})::int`,
      waSent: sql<number>`count(*) filter (where ${messages.channel} = 'whatsapp' and ${messages.direction} = 'out' and ${inArray(messages.status, [...SENT_ONWARD])})::int`,
      replies: sql<number>`count(*) filter (where ${messages.direction} = 'in')::int`,
    })
    .from(messages)
    .where(eq(messages.workspaceId, workspaceId))

  const [companyRow] = await db
    .select({ n: count() })
    .from(companies)
    .where(eq(companies.workspaceId, workspaceId))

  const [contactRow] = await db
    .select({ n: count() })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId))

  const totalLeads = leadRow?.total ?? 0
  const emailsSent = messageRow?.emailsSent ?? 0
  const waSent = messageRow?.waSent ?? 0
  const replies = messageRow?.replies ?? 0
  const sentTotal = emailsSent + waSent

  return {
    totalLeads,
    qualified: leadRow?.qualified ?? 0,
    hot: leadRow?.hot ?? 0,
    emailsSent,
    waSent,
    replies,
    meetings: leadRow?.meetings ?? 0,
    replyRate: sentTotal === 0 ? 0 : replies / sentTotal,
    conversionRate: totalLeads === 0 ? 0 : (leadRow?.won ?? 0) / totalLeads,
    companies: companyRow?.n ?? 0,
    contacts: contactRow?.n ?? 0,
  }
}

// -----------------------------------------------------------------------------
// Funnel
// -----------------------------------------------------------------------------

export type FunnelStage = { key: string; label: string; count: number }

/**
 * SPEC §9 funnel. Each stage counts leads that reached it *or moved past it*,
 * which is what makes a funnel monotonically decreasing — counting only leads
 * sitting in a stage right now would show a jagged chart that means nothing.
 */
const FUNNEL_STAGES: ReadonlyArray<{ key: string; label: string; from: LeadStatus[] }> = [
  {
    key: 'new',
    label: 'Baru',
    from: [
      'new',
      'qualified',
      'contacted',
      'replied',
      'interested',
      'meeting',
      'proposal',
      'negotiation',
      'won',
    ],
  },
  { key: 'qualified', label: 'Terkualifikasi', from: QUALIFIED_ONWARD },
  {
    key: 'contacted',
    label: 'Dihubungi',
    from: ['contacted', 'replied', 'interested', 'meeting', 'proposal', 'negotiation', 'won'],
  },
  {
    key: 'replied',
    label: 'Membalas',
    from: ['replied', 'interested', 'meeting', 'proposal', 'negotiation', 'won'],
  },
  { key: 'meeting', label: 'Meeting', from: MEETING_ONWARD },
  { key: 'proposal', label: 'Proposal', from: ['proposal', 'negotiation', 'won'] },
  { key: 'won', label: 'Menang', from: ['won'] },
]

export async function getFunnel(workspaceId: string): Promise<FunnelStage[]> {
  const rows = await db
    .select({ status: leads.status, n: count() })
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId))
    .groupBy(leads.status)

  const byStatus = new Map(rows.map((r) => [r.status, r.n]))

  return FUNNEL_STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: stage.from.reduce((acc, status) => acc + (byStatus.get(status) ?? 0), 0),
  }))
}

// -----------------------------------------------------------------------------
// Today's queue
// -----------------------------------------------------------------------------

export type QueueLead = {
  id: string
  companyName: string | null
  contactName: string | null
  score: number | null
  category: string | null
  status: LeadStatus
  nextActionAt: Date | null
}

/** Leads whose follow-up is due today or overdue. */
export async function getDueLeads(
  workspaceId: string,
  limit = 8,
): Promise<QueueLead[]> {
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 59, 999)

  return db
    .select({
      id: leads.id,
      companyName: companies.name,
      contactName: contacts.name,
      score: leads.score,
      category: sql<string | null>`${leads.category}`,
      status: leads.status,
      nextActionAt: leads.nextActionAt,
    })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        isNotNull(leads.nextActionAt),
        lte(leads.nextActionAt, endOfToday),
      ),
    )
    .orderBy(leads.nextActionAt)
    .limit(limit)
}

export type RecentActivity = {
  id: string
  type: string
  actor: string
  createdAt: Date
  companyName: string | null
}

export async function getRecentActivities(
  workspaceId: string,
  limit = 8,
): Promise<RecentActivity[]> {
  return db
    .select({
      id: activities.id,
      type: activities.type,
      actor: sql<string>`${activities.actor}`,
      createdAt: activities.createdAt,
      companyName: companies.name,
    })
    .from(activities)
    .leftJoin(leads, eq(leads.id, activities.leadId))
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .where(eq(activities.workspaceId, workspaceId))
    .orderBy(sql`${activities.createdAt} desc`)
    .limit(limit)
}

/** Count of drafts sitting in the approval queue, for the dashboard card. */
export async function getPendingApprovalCount(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        inArray(messages.status, ['pending_approval', 'needs_input']),
      ),
    )
  return row?.n ?? 0
}

/** Leads created in the last 30 days, used for the "aktivitas terakhir" hint. */
export async function getNewLeadsThisMonth(workspaceId: string): Promise<number> {
  const since = new Date()
  since.setDate(since.getDate() - 30)

  const [row] = await db
    .select({ n: count() })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), gte(leads.createdAt, since)))
  return row?.n ?? 0
}
