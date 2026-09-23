import { z } from 'zod'

/**
 * What the content generator is allowed to return (docs/SPEC.md §5).
 *
 * Two things this shape deliberately does NOT do:
 *
 * 1. **It does not decide the draft's status.** `missing_info` is the model's own
 *    report of what it could not find, and it is believed only in the direction
 *    that makes a draft *less* sendable. A model that returns `missing_info: []`
 *    while writing an invented price is wrong, and `lib/outreach/grounding.ts`
 *    overrules it. Same division as the scoring rubric: the model supplies
 *    judgement, the code decides the outcome.
 * 2. **It does not carry a channel.** This is the email draft schema; WhatsApp
 *    needs an approved Cloud API template and variables, not free text, and waits
 *    for Modules 6/7.
 */

/** One short line a salesperson reads in the approval queue. */
const note = z.string().trim().min(3).max(200)

export const generateContentSchema = z.object({
  /** Subject line. Short enough to survive a mobile inbox. */
  subject: z.string().trim().min(5).max(150),
  /** The email as it will be stored in `messages.body`, CTA sentence included. */
  body: z.string().trim().min(40).max(2500),
  /** The ask, repeated on its own so the reviewer can judge it without re-reading. */
  cta: note,
  /** Every personalisation claim, each naming the stored field behind it. */
  personalization_used: z.array(note).max(8),
  /** Facts the model could not find. Non-empty means `needs_input` (SPEC §5). */
  missing_info: z.array(note).max(8),
  /** 0–1. Advisory only — it gates nothing. */
  confidence: z.number().min(0).max(1),
})

export type GenerateContentOutput = z.infer<typeof generateContentSchema>
