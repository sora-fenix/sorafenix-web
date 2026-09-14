import 'server-only'

import { and, eq, isNull, or } from 'drizzle-orm'

import { writeActivity } from '@/lib/crm/activity'
import { transitionLeadStatus } from '@/lib/crm/status'
import { db, schema } from '@/lib/db/drizzle'

import {
  type LeadSignals,
  SIGNAL_RUBRIC,
  type SignalBreakdown,
  classifySignals,
} from './signals'

/**
 * Lead classification over stored place signals — the write side of
 * `signals.ts`.
 *
 * The deterministic counterpart to `score.ts`. Same columns written (`score`,
 * `category`, `score_factors`, `score_reason`), same audit obligations, no model
 * call anywhere. That means no injected provider, no timeout, no retry and no
 * `ai_runs` row: there is nothing here that can fail slowly or answer differently
 * twice.
 *
 * One transaction per lead rather than one for the batch. A run over the 1208
 * scraped rows in `data-riil` should not lose 1207 good classifications because
 * the 1208th hit a constraint, and a run interrupted halfway should leave the half
 * it finished committed and skippable on the next pass.
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ClassifyLeadsInput = {
  readonly workspaceId: string
  /** Re-classify leads that already carry a score. Off by default. */
  readonly reclassify?: boolean
  /** Cap the batch. Undefined means every candidate. */
  readonly limit?: number
  /** Compute and report, write nothing. */
  readonly dryRun?: boolean
}

export type ClassifiedLead = SignalBreakdown & {
  readonly leadId: string
  readonly companyName: string
  /** Present only when the lead actually moved. */
  readonly statusChangedTo: 'qualified' | null
}

export type ClassifyLeadsResult = {
  readonly considered: number
  readonly classified: readonly ClassifiedLead[]
  readonly hot: number
  readonly warm: number
  readonly cold: number
  readonly qualified: number
  readonly dryRun: boolean
}

/**
 * Which bands earn `qualified`.
 *
 * `cold` deliberately stays `new`. `score.ts` moves every scored lead to
 * `qualified` regardless of band, which is defensible for a dozen hand-picked
 * leads and wrong for 1208 scraped ones — it would mark the entire database
 * qualified, including the businesses the rubric just judged weakest, and empty
 * the word of meaning for the salesperson reading the pipeline.
 */
function earnsQualified(breakdown: SignalBreakdown): boolean {
  return breakdown.category !== 'cold'
}

export async function classifyLeads(
  input: ClassifyLeadsInput,
): Promise<ClassifyLeadsResult> {
  const candidates = await loadCandidates(input)
  const dryRun = input.dryRun === true

  const classified: ClassifiedLead[] = []

  for (const candidate of candidates) {
    const breakdown = classifySignals(candidate.signals)

    const statusChangedTo = dryRun
      ? null
      : await db.transaction((tx) => persist(tx, input.workspaceId, candidate, breakdown))

    classified.push({
      ...breakdown,
      leadId: candidate.leadId,
      companyName: candidate.companyName,
      statusChangedTo,
    })
  }

  return {
    considered: candidates.length,
    classified,
    hot: classified.filter((lead) => lead.category === 'hot').length,
    warm: classified.filter((lead) => lead.category === 'warm').length,
    cold: classified.filter((lead) => lead.category === 'cold').length,
    qualified: classified.filter((lead) => lead.statusChangedTo !== null).length,
    dryRun,
  }
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

async function persist(
  tx: Transaction,
  workspaceId: string,
  candidate: Candidate,
  breakdown: SignalBreakdown,
): Promise<'qualified' | null> {
  await tx
    .update(schema.leads)
    .set({
      score: breakdown.score,
      category: breakdown.category,
      scoreFactors: breakdown.factors,
      scoreReason: breakdown.reason,
      updatedAt: new Date(),
    })
    // rule 6: Drizzle bypasses RLS, so workspace_id is filtered on every query.
    .where(
      and(
        eq(schema.leads.id, candidate.leadId),
        eq(schema.leads.workspaceId, workspaceId),
      ),
    )

  await writeActivity(tx, {
    workspaceId,
    leadId: candidate.leadId,
    type: 'lead_scored',
    // Not 'ai'. No model was asked anything; the number came out of a function.
    actor: 'system',
    payload: {
      // Both rubrics write `leads.score`, on the same 0-100 scale but from
      // different evidence. Without this key a 62 from signals and a 62 from the
      // model are indistinguishable six months from now.
      rubric: SIGNAL_RUBRIC,
      score: breakdown.score,
      category: breakdown.category,
      factors: breakdown.factors.map((factor) => ({
        key: factor.key,
        score: factor.score,
      })),
    },
  })

  if (candidate.status !== 'new') return null
  if (!earnsQualified(breakdown)) return null

  const moved = await transitionLeadStatus(tx, {
    workspaceId,
    leadId: candidate.leadId,
    to: 'qualified',
    actor: 'system',
    note: `Skor sinyal ${breakdown.score} (${breakdown.category}).`,
  })

  return moved.ok ? 'qualified' : null
}

// -----------------------------------------------------------------------------
// Loading — stored columns only
// -----------------------------------------------------------------------------

type Candidate = {
  readonly leadId: string
  readonly status: (typeof schema.leads.status.enumValues)[number]
  readonly companyName: string
  readonly signals: LeadSignals
}

async function loadCandidates(input: ClassifyLeadsInput): Promise<Candidate[]> {
  const unscoredOnly = input.reclassify !== true

  const base = db
    .select({
      leadId: schema.leads.id,
      status: schema.leads.status,
      companyName: schema.companies.name,
      rating: schema.companies.rating,
      reviewCount: schema.companies.reviewCount,
      website: schema.companies.website,
      domain: schema.companies.domain,
      city: schema.companies.city,
      category: schema.companies.industry,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      whatsapp: schema.contacts.whatsapp,
    })
    .from(schema.leads)
    // The join carries workspace_id too. The foreign key already guarantees these
    // rows belong together; repeating the filter means a query copied out of here
    // into a looser context cannot quietly cross a tenant boundary.
    .innerJoin(
      schema.companies,
      and(
        eq(schema.companies.id, schema.leads.companyId),
        eq(schema.companies.workspaceId, input.workspaceId),
      ),
    )
    .leftJoin(
      schema.contacts,
      and(
        eq(schema.contacts.id, schema.leads.contactId),
        eq(schema.contacts.workspaceId, input.workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.leads.workspaceId, input.workspaceId),
        // A lead a salesperson has already worked is not re-judged by a sweep:
        // only `new` and `qualified` are still the rubric's to decide.
        or(eq(schema.leads.status, 'new'), eq(schema.leads.status, 'qualified')),
        unscoredOnly ? isNull(schema.leads.score) : undefined,
      ),
    )
    .orderBy(schema.leads.createdAt)

  const rows =
    input.limit === undefined || input.limit <= 0 ? await base : await base.limit(input.limit)

  return rows.map((row) => ({
    leadId: row.leadId,
    status: row.status,
    companyName: row.companyName,
    signals: {
      rating: row.rating,
      reviewCount: row.reviewCount,
      website: row.website,
      domain: row.domain,
      email: row.email,
      phone: row.phone,
      whatsapp: row.whatsapp,
      city: row.city,
      category: row.category,
    },
  }))
}
