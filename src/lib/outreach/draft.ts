import 'server-only'

import { and, asc, eq, isNotNull } from 'drizzle-orm'

import { type AgentError, type AgentSuccess, runAgent } from '@/lib/ai/agent'
import { generatePrompt, generateSystemPrompt } from '@/lib/ai/prompts/generate'
import {
  type GenerateContentOutput,
  generateContentSchema,
} from '@/lib/ai/schemas/generate'
import { writeActivity } from '@/lib/crm/activity'
import { db, schema } from '@/lib/db/drizzle'
import type { LeadStatus } from '@/lib/db/schema'
import { type Result, err, ok } from '@/lib/types/result'

import {
  type Claim,
  type DraftDecision,
  type DraftStatus,
  decideDraftStatus,
} from './grounding'

/**
 * The AI content generator (docs/SPEC.md §5, Module 5).
 *
 * Load the lead from stored columns → ask the model for one email → let
 * `grounding.ts` decide whether it may be called ready → write ONE `messages` row
 * and the audit row in one transaction.
 *
 * Nothing here sends anything, and nothing here can. The row lands at
 * `pending_approval` or `needs_input`, and `send-guard.ts` refuses both at check 5
 * (approval). Human-in-the-loop is the default and this slice does not build the
 * approve button.
 *
 * The model is injected so `tests/integration/generate.test.ts` can script it —
 * the same shape `scoring/score.ts` uses. Production callers use `generateDraft`.
 */

export type GenerateDraftInput = {
  readonly workspaceId: string
  readonly leadId: string
  /** Draft again for a lead that already has an outbound message. Off by default. */
  readonly regenerate?: boolean
}

export type GenerateDraftError =
  | { readonly kind: 'lead_not_found' }
  /** Only qualified leads get drafted. SPEC §5 sits after Module 3, not beside it. */
  | { readonly kind: 'not_qualified'; readonly status: LeadStatus }
  /** Counted and reported by the caller, never silently skipped. */
  | { readonly kind: 'no_contact_email' }
  | { readonly kind: 'already_drafted' }
  /**
   * The idempotency key was taken. Another run got there first, or an earlier
   * draft was deleted and freed the attempt number without freeing the key. No
   * duplicate row was written — see `writeDraft`.
   */
  | { readonly kind: 'duplicate_draft' }
  | { readonly kind: 'model_failed'; readonly error: AgentError }

export type GenerateDraftSuccess = {
  readonly messageId: string
  readonly leadId: string
  readonly status: DraftStatus
  readonly subject: string
  readonly missingInfo: readonly string[]
  readonly ungrounded: readonly Claim[]
  readonly personalizationUsed: readonly string[]
  readonly confidence: number
  readonly costUsd: number
  readonly latencyMs: number
}

export type GenerateRequest = {
  readonly workspaceId: string
  readonly system: string
  readonly prompt: string
}

export type DraftDeps = {
  readonly generate: (
    request: GenerateRequest,
  ) => Promise<Result<AgentSuccess<GenerateContentOutput>, AgentError>>
}

export async function generateDraft(
  input: GenerateDraftInput,
): Promise<Result<GenerateDraftSuccess, GenerateDraftError>> {
  return generateDraftWith(input, { generate: callGenerateAgent })
}

export async function generateDraftWith(
  input: GenerateDraftInput,
  deps: DraftDeps,
): Promise<Result<GenerateDraftSuccess, GenerateDraftError>> {
  const context = await loadContext(input.workspaceId, input.leadId)
  if (context === null) return err({ kind: 'lead_not_found' })

  // Eligibility is checked before the model, not after: every refusal below costs
  // nothing, and a draft nobody can send is worse than no draft.
  if (context.status !== 'qualified') {
    return err({ kind: 'not_qualified', status: context.status })
  }
  if (context.contactEmail === null || context.contactEmail === '') {
    return err({ kind: 'no_contact_email' })
  }
  if (context.outboundCount > 0 && input.regenerate !== true) {
    return err({ kind: 'already_drafted' })
  }

  const answer = await deps.generate({
    workspaceId: input.workspaceId,
    system: generateSystemPrompt(),
    prompt: generatePrompt({
      senderName: context.senderName,
      product: context.product,
      company: context.company,
      contact: context.contact,
      lead: context.lead,
      knowledge: context.knowledge,
    }),
  })

  if (!answer.ok) return err({ kind: 'model_failed', error: answer.error })

  const draft = {
    subject: answer.value.value.subject,
    body: answer.value.value.body,
    cta: answer.value.value.cta,
  }

  // This is where the status is decided. The model's own missing_info is one of
  // three inputs, and the only one it controls.
  const decision = decideDraftStatus({
    draft,
    modelMissingInfo: answer.value.value.missing_info,
    knowledge: context.knowledge.map((doc) => doc.content),
  })

  const written = await writeDraft(input, context.outboundCount, draft, decision, answer.value)
  if (!written.ok) return written

  return ok({
    messageId: written.value,
    leadId: input.leadId,
    status: decision.status,
    subject: draft.subject,
    missingInfo: decision.missingInfo,
    ungrounded: decision.ungrounded,
    personalizationUsed: answer.value.value.personalization_used,
    confidence: answer.value.value.confidence,
    costUsd: answer.value.costUsd,
    latencyMs: answer.value.latencyMs,
  })
}

/**
 * The write, as its own step, because one of its failures is expected rather than
 * exceptional.
 *
 * `messages_workspace_idempotency_key` is what actually stops a duplicate draft —
 * the attempt counter only picks the key. Two overlapping runs, or a `--regenerate`
 * after someone deleted an earlier draft so the count collides again, both land on
 * a unique violation. Idempotency holds either way: no second row is ever created.
 * But the violation used to throw straight out of a function typed
 * `Promise<Result<…>>` (rule 9), which aborted a whole sweep over one lead instead
 * of recording a skip and moving on.
 */
async function writeDraft(
  input: GenerateDraftInput,
  attempt: number,
  draft: { readonly subject: string; readonly body: string; readonly cta: string },
  decision: DraftDecision,
  answer: AgentSuccess<GenerateContentOutput>,
): Promise<Result<string, GenerateDraftError>> {
  try {
    return ok(await insertDraft(input, attempt, draft, decision, answer))
  } catch (error) {
    if (isUniqueViolation(error)) return err({ kind: 'duplicate_draft' })
    throw error
  }
}

/**
 * Postgres 23505, wherever it ended up.
 *
 * Drizzle wraps the driver's error in a `DrizzleQueryError`, so the SQLSTATE is on
 * the `cause`, not on what was thrown — checking only the top level silently never
 * matches, which is how this looked fixed while still escaping. The chain is
 * walked with a depth bound rather than a `while (true)`: a self-referencing cause
 * must not hang the sweep it was added to protect.
 *
 * Read through `Reflect.get` rather than a cast, because the value a driver throws
 * is genuinely `unknown` and rule 9 does not allow pretending otherwise.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    if (Reflect.get(current, 'code') === '23505') return true
    current = Reflect.get(current, 'cause')
  }

  return false
}

async function insertDraft(
  input: GenerateDraftInput,
  attempt: number,
  draft: { readonly subject: string; readonly body: string; readonly cta: string },
  decision: DraftDecision,
  answer: AgentSuccess<GenerateContentOutput>,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(schema.messages)
      .values({
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        channel: 'email',
        direction: 'out',
        status: decision.status,
        subject: draft.subject,
        body: draft.body,
        idempotencyKey: draftIdempotencyKey(input.leadId, attempt),
      })
      .returning({ id: schema.messages.id })

    if (message === undefined) throw new Error('draft insert returned no row')

    // rule 10, and the same payload shape `scoring/score.ts` writes for
    // `lead_scored`: everything the model said survives the status decision, so a
    // reviewer can see what it claimed as well as what we did about it.
    await writeActivity(tx, {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      type: 'message_drafted',
      actor: 'ai',
      channel: 'email',
      payload: {
        messageId: message.id,
        status: decision.status,
        model: answer.model,
        cta: answer.value.cta,
        confidence: answer.value.confidence,
        personalization_used: answer.value.personalization_used,
        /** What the model reported, before the grounding check added to it. */
        model_missing_info: answer.value.missing_info,
        missing_info: decision.missingInfo,
        ungrounded: decision.ungrounded.map((claim) => ({
          kind: claim.kind,
          term: claim.term,
        })),
      },
    })

    return message.id
  })
}

/**
 * Deterministic per lead and per attempt, so re-running the script over the same
 * lead cannot produce two rows for the same attempt: the unique index on
 * (workspace_id, idempotency_key) refuses the second one.
 */
export function draftIdempotencyKey(leadId: string, attempt: number): string {
  return `draft:email:${leadId}:${attempt}`
}

// -----------------------------------------------------------------------------
// Loading — stored columns only, nothing derived
// -----------------------------------------------------------------------------

async function loadContext(workspaceId: string, leadId: string) {
  const [row] = await db
    .select({
      status: schema.leads.status,
      score: schema.leads.score,
      category: schema.leads.category,
      scoreReason: schema.leads.scoreReason,
      workspaceName: schema.workspaces.name,
      companyName: schema.companies.name,
      industry: schema.companies.industry,
      city: schema.companies.city,
      sizeBand: schema.companies.sizeBand,
      employeeCount: schema.companies.employeeCount,
      description: schema.companies.description,
      website: schema.companies.website,
      contactName: schema.contacts.name,
      position: schema.contacts.position,
      department: schema.contacts.department,
      contactEmail: schema.contacts.email,
    })
    .from(schema.leads)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.leads.workspaceId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.leads.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.leads.contactId))
    // rule 6: workspace_id on every Drizzle query, without exception.
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.workspaceId, workspaceId)))
    .limit(1)

  if (row === undefined || row.companyName === null) return null

  // One product per workspace in the MVP, exactly as lib/scoring/score.ts loads it.
  const [product] = await db
    .select({
      name: schema.products.name,
      description: schema.products.description,
      valueProp: schema.products.valueProp,
    })
    .from(schema.products)
    .where(eq(schema.products.workspaceId, workspaceId))
    .limit(1)

  // Active docs only. An archived pricelist must not ground a price we no longer
  // charge, which is the whole reason `is_active` exists.
  const knowledge = await db
    .select({
      type: schema.knowledgeDocs.type,
      title: schema.knowledgeDocs.title,
      content: schema.knowledgeDocs.content,
    })
    .from(schema.knowledgeDocs)
    .where(
      and(
        eq(schema.knowledgeDocs.workspaceId, workspaceId),
        eq(schema.knowledgeDocs.isActive, true),
        isNotNull(schema.knowledgeDocs.content),
      ),
    )
    .orderBy(asc(schema.knowledgeDocs.createdAt))

  const outbound = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.messages.leadId, leadId),
        eq(schema.messages.direction, 'out'),
      ),
    )

  return {
    status: row.status,
    senderName: row.workspaceName,
    contactEmail: row.contactEmail,
    outboundCount: outbound.length,
    company: {
      name: row.companyName,
      industry: row.industry,
      city: row.city,
      sizeBand: row.sizeBand,
      employeeCount: row.employeeCount,
      description: row.description,
      website: row.website,
    },
    contact:
      row.contactName === null && row.position === null
        ? null
        : { name: row.contactName, position: row.position, department: row.department },
    product: product ?? null,
    lead: { score: row.score, category: row.category, scoreReason: row.scoreReason },
    knowledge: knowledge.flatMap((doc) =>
      doc.content === null ? [] : [{ type: doc.type, title: doc.title, content: doc.content }],
    ),
  }
}

async function callGenerateAgent(
  request: GenerateRequest,
): Promise<Result<AgentSuccess<GenerateContentOutput>, AgentError>> {
  return runAgent({
    workspaceId: request.workspaceId,
    agent: 'generate_content',
    system: request.system,
    prompt: request.prompt,
    schema: generateContentSchema,
  })
}
