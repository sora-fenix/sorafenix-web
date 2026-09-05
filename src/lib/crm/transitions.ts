/**
 * The lead status graph (docs/SPEC.md §1).
 *
 * Import-free and pure, for the same reason `lib/scoring/rubric.ts` and
 * `lib/ai/policy.ts` are: `status.ts` has to reach the database, and the unit suite
 * must be able to prove which moves are legal without one. This file decides;
 * `status.ts` writes.
 */

export const LEAD_STATUSES = [
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
] as const

export type LeadStatus = (typeof LEAD_STATUSES)[number]

/**
 * The one-way chain from SPEC §1. A lead advances exactly one step at a time.
 *
 * Skipping is refused on purpose. "Contacted without ever being qualified" is
 * usually a bug — a send that ran before scoring, or a status written by something
 * that should not be writing status at all — and a graph that permits everything
 * catches neither. If the product later needs to skip, that is a SPEC change with
 * a test to match, not a quiet widening here.
 */
const CHAIN: readonly LeadStatus[] = [
  'new',
  'qualified',
  'contacted',
  'replied',
  'interested',
  'meeting',
  'proposal',
  'negotiation',
  'won',
]

/** Nothing leaves these. `won` is an outcome, not a stage. */
export const TERMINAL_STATUSES: readonly LeadStatus[] = ['won', 'lost', 'do_not_contact']

/**
 * Reachable from anywhere that is not already terminal.
 *
 * A deal dies at any stage, and "jangan hubungi" must be honourable the moment it
 * arrives — `.claude/rules/outreach.md` requires an opt-out to stop everything
 * immediately, which it cannot do if the graph makes it wait its turn.
 */
const ESCAPES: readonly LeadStatus[] = ['lost', 'do_not_contact']

export type TransitionRefusal = 'unchanged' | 'terminal' | 'not_allowed'

export function isTerminal(status: LeadStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** The status that follows `from` on the chain, or null at the end of it. */
export function nextInChain(from: LeadStatus): LeadStatus | null {
  const index = CHAIN.indexOf(from)
  if (index === -1) return null
  return CHAIN[index + 1] ?? null
}

/**
 * Whether `from → to` is legal, and why not when it is not.
 *
 * Returns null when the move is allowed. A same-to-same move is refused rather than
 * silently accepted: it means the caller did not check, and an activity row saying
 * "status changed from qualified to qualified" is noise in the one trail that has
 * to stay readable.
 */
export function refuseTransition(from: LeadStatus, to: LeadStatus): TransitionRefusal | null {
  if (from === to) return 'unchanged'
  if (isTerminal(from)) return 'terminal'
  if (ESCAPES.includes(to)) return null
  if (nextInChain(from) === to) return null
  return 'not_allowed'
}

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return refuseTransition(from, to) === null
}

/** Every status reachable from `from`, in graph order. Drives UI menus later. */
export function allowedTransitions(from: LeadStatus): readonly LeadStatus[] {
  if (isTerminal(from)) return []
  const next = nextInChain(from)
  return [...(next === null ? [] : [next]), ...ESCAPES]
}

export function isLeadStatus(value: string): value is LeadStatus {
  return LEAD_STATUSES.some((status) => status === value)
}
