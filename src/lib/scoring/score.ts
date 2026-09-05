import 'server-only'

import { and, eq } from 'drizzle-orm'

import { type AgentError, type AgentSuccess, runAgent } from '@/lib/ai/agent'
import { qualifyPrompt, qualifySystemPrompt } from '@/lib/ai/prompts/qualify'
import { type QualifyOutput, qualifySchema } from '@/lib/ai/schemas/qualify'
import { writeActivity } from '@/lib/crm/activity'
import { transitionLeadStatus } from '@/lib/crm/status'
import { db, schema } from '@/lib/db/drizzle'
import { type Result, err, ok } from '@/lib/types/result'

import { type ScoreBreakdown, computeScore } from './rubric'

/**
 * Lead qualification (docs/SPEC.md §4, Module 3).
 *
 * Load the lead from stored columns → ask the model for six sub-scores → compute
 * the total in `rubric.ts` → write the score, the audit row and the status move in
 * one transaction.
 *
 * The model is injected so `tests/integration/qualify.test.ts` can script it —
 * the same shape `agent.ts` uses for its provider and `dedupe.ts` for its lookups
 * (decision 24). Production callers use `scoreLead`, which wires the real one.
 */

export type ScoreLeadInput = {
  readonly workspaceId: string
  readonly leadId: string
  /** Re-score a lead that already has one. Off by default, so a re-run is cheap. */
  readonly rescore?: boolean
}

export type ScoreLeadError =
  | { readonly kind: 'lead_not_found' }
  | { readonly kind: 'already_scored' }
  | { readonly kind: 'model_failed'; readonly error: AgentError }

export type ScoreLeadSuccess = ScoreBreakdown & {
  readonly leadId: string
  readonly reason: string
  /** Present only when the lead actually moved. A lead past `new` keeps its status. */
  readonly statusChangedTo: 'qualified' | null
  readonly costUsd: number
  readonly latencyMs: number
}

export type ScoreDeps = {
  readonly qualify: (
    input: QualifyRequest,
  ) => Promise<Result<AgentSuccess<QualifyOutput>, AgentError>>
}

export type QualifyRequest = {
  readonly workspaceId: string
  readonly system: string
  readonly prompt: string
}

export async function scoreLead(
  input: ScoreLeadInput,
): Promise<Result<ScoreLeadSuccess, ScoreLeadError>> {
  return scoreLeadWith(input, { qualify: callQualifyAgent })
}

export async function scoreLeadWith(
  input: ScoreLeadInput,
  deps: ScoreDeps,
): Promise<Result<ScoreLeadSuccess, ScoreLeadError>> {
  const context = await loadContext(input.workspaceId, input.leadId)
  if (context === null) return err({ kind: 'lead_not_found' })

  if (context.score !== null && input.rescore !== true) {
    return err({ kind: 'already_scored' })
  }

  const answer = await deps.qualify({
    workspaceId: input.workspaceId,
    system: qualifySystemPrompt(),
    prompt: qualifyPrompt({
      company: context.company,
      contact: context.contact,
      product: context.product,
    }),
  })

  if (!answer.ok) return err({ kind: 'model_failed', error: answer.error })

  // The model returned sub-scores only. This is where the number is decided.
  const breakdown = computeScore(answer.value.value.factors)
  const reason = answer.value.value.reason

  const statusChangedTo = await db.transaction(async (tx) => {
    await tx
      .update(schema.leads)
      .set({
        score: breakdown.score,
        category: breakdown.category,
        scoreFactors: breakdown.factors,
        scoreReason: reason,
        updatedAt: new Date(),
      })
      // rule 6: workspace_id on every Drizzle query, without exception.
      .where(
        and(
          eq(schema.leads.id, input.leadId),
          eq(schema.leads.workspaceId, input.workspaceId),
        ),
      )

    await writeActivity(tx, {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      type: 'lead_scored',
      actor: 'ai',
      payload: {
        score: breakdown.score,
        category: breakdown.category,
        model: answer.value.model,
        factors: breakdown.factors.map((factor) => ({
          key: factor.key,
          score: factor.score,
        })),
      },
    })

    // Only a lead still sitting at `new` advances. Re-scoring one that a
    // salesperson has already contacted must not drag it backwards.
    if (context.status !== 'new') return null

    const moved = await transitionLeadStatus(tx, {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      to: 'qualified',
      actor: 'ai',
      note: `Skor ${breakdown.score} (${breakdown.category}).`,
    })

    return moved.ok ? 'qualified' : null
  })

  return ok({
    ...breakdown,
    leadId: input.leadId,
    reason,
    statusChangedTo,
    costUsd: answer.value.costUsd,
    latencyMs: answer.value.latencyMs,
  })
}

// -----------------------------------------------------------------------------
// Loading — stored columns only, nothing derived
// -----------------------------------------------------------------------------

async function loadContext(workspaceId: string, leadId: string) {
  const [row] = await db
    .select({
      status: schema.leads.status,
      score: schema.leads.score,
      companyName: schema.companies.name,
      industry: schema.companies.industry,
      city: schema.companies.city,
      sizeBand: schema.companies.sizeBand,
      employeeCount: schema.companies.employeeCount,
      description: schema.companies.description,
      contactName: schema.contacts.name,
      position: schema.contacts.position,
      department: schema.contacts.department,
    })
    .from(schema.leads)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.leads.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.leads.contactId))
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.workspaceId, workspaceId)))
    .limit(1)

  if (row === undefined || row.companyName === null) return null

  // One product per workspace in the MVP. When a campaign carries its own product
  // this becomes a join through campaigns; today it would be a distinction without
  // a difference.
  const [product] = await db
    .select({
      name: schema.products.name,
      description: schema.products.description,
      valueProp: schema.products.valueProp,
      icp: schema.products.icp,
    })
    .from(schema.products)
    .where(eq(schema.products.workspaceId, workspaceId))
    .limit(1)

  return {
    status: row.status,
    score: row.score,
    company: {
      name: row.companyName,
      industry: row.industry,
      city: row.city,
      sizeBand: row.sizeBand,
      employeeCount: row.employeeCount,
      description: row.description,
    },
    contact:
      row.contactName === null && row.position === null
        ? null
        : { name: row.contactName, position: row.position, department: row.department },
    product: product ?? null,
  }
}

async function callQualifyAgent(
  request: QualifyRequest,
): Promise<Result<AgentSuccess<QualifyOutput>, AgentError>> {
  return runAgent({
    workspaceId: request.workspaceId,
    agent: 'qualify',
    system: request.system,
    prompt: request.prompt,
    schema: qualifySchema,
  })
}
