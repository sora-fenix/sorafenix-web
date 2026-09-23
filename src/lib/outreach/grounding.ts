/**
 * The grounding check for AI-written drafts (docs/SPEC.md §5, .claude/rules/ai.md).
 *
 * The model reports what it thinks it was missing. This file decides whether the
 * draft may be shown to a human as ready — and it overrules the model. A model
 * that answers `missing_info: []` while writing "hanya Rp 1.500.000 per bulan" has
 * not reported a gap; it has invented a price, and an invented price is a lie sent
 * to a customer under our name. So the text itself is scanned, and a price-shaped
 * string that is not verbatim in the workspace's ACTIVE knowledge_docs forces
 * `needs_input` whatever the model said.
 *
 * Same division `lib/scoring/rubric.ts` already enforces: the model supplies
 * judgement, the code decides the outcome. Nothing here imports anything and
 * nothing here does I/O, so every rule below is testable without a model, a key or
 * a database.
 *
 * It is deliberately narrower than "check every claim". Entailment-matching
 * arbitrary prose against a knowledge base is a research problem, and a bad
 * approximation of it would either flag every draft or lull a reviewer into
 * trusting it. What is caught here is the category SPEC §5 names and that a
 * salesperson cannot check at a glance: money, discounts, percentages, and numeric
 * delivery commitments. Everything else is what the human approval step is for.
 *
 * WHAT THIS DETECTOR DOES NOT CATCH
 *
 * Measured, not guessed — each of these was probed against the real matcher. They
 * are written down rather than closed because human approval is the backstop and
 * because a known hole is a decision, while an unknown one is a trap for whoever
 * extends this next:
 *
 *   - **Spelled-out numbers evade entirely.** "dua ratus ribu rupiah" produces no
 *     claim at all, because every detector is anchored on digits.
 *   - **Non-rupiah currency evades entirely.** "USD 99 per month", "$99 per month"
 *     and "99 dollar" produce no claim. A digit-and-magnitude amount is read as
 *     rupiah, and a foreign amount written plainly is not read at all. Indonesian
 *     rupiah, in every digit form, IS covered — with the marker ("Rp 299.000"),
 *     with a magnitude word instead ("199 ribu", "1,5 juta", "299rb"), and bare
 *     ("299.000").
 *   - **An amount under 1.000 with no marker and no magnitude word evades.** "Harga
 *     500 per unit" produces no claim, because a bare three-digit number is a
 *     quantity far more often than it is a price.
 *   - **Units are never compared, only numbers.** "Rp 299.000 per transaksi"
 *     grounds cleanly against a doc that only supports "Rp 299.000 per bulan".
 *     The amount matches; nothing checks what it is charged for.
 *   - **A bare discount word grounds on the word alone.** "diskon" is satisfied by
 *     any active doc containing "diskon", whatever number sits next to it. The
 *     number beside it is checked separately, as a percentage or an amount, so
 *     "diskon 50%" against a doc offering 15% is still refused — but "diskon
 *     khusus untuk Anda" is not.
 *
 * What was probed and does NOT leak, so nobody re-litigates it: ranges,
 * "mulai dari", per-unit pricing such as "Rp 2.000 per transaksi", informal prices
 * ("199 ribu", "299rb", "1,5 juta"), bare grouped prices ("299.000"), delivery
 * promises above 999 ("1.500 jam"), and a number that is merely a digit-suffix of
 * a real one ("5%" against a doc saying "15%", "1 hari" against "21 hari"). See
 * `groundsIn` for that last one.
 */

/** Written into the body where a fact belongs but is not known. The prompt quotes it. */
export const PLACEHOLDER_EXAMPLE = '[harga paket]'

export type ClaimKind =
  /** A rupiah amount. */
  | 'currency'
  /** A percentage — a discount, a saving, a growth figure. */
  | 'percentage'
  /** Discount, promo or free-of-charge vocabulary, with or without a number. */
  | 'discount'
  /** A number attached to a time unit: "5 hari", "24 jam", "1 tahun". */
  | 'commitment'

export type Claim = {
  readonly kind: ClaimKind
  /**
   * The normalised form that was compared against the knowledge base. Normalised
   * rather than verbatim so "Rp 299.000", "Rp299.000" and "IDR 299.000" are one
   * claim and not three.
   */
  readonly term: string
}

export type DraftText = {
  readonly subject: string
  readonly body: string
  /**
   * Scanned too. A model that keeps the price out of the body and puts it in the
   * ask has still quoted a price.
   */
  readonly cta: string
}

export type DraftStatus = 'pending_approval' | 'needs_input'

export type DraftDecisionInput = {
  readonly draft: DraftText
  /** What the model itself said was missing. Considered, never trusted alone. */
  readonly modelMissingInfo: readonly string[]
  /** `content` of the workspace's ACTIVE knowledge_docs. Nothing else counts. */
  readonly knowledge: readonly string[]
}

export type DraftDecision = {
  readonly status: DraftStatus
  /** Price-shaped claims with no support in the knowledge base. */
  readonly ungrounded: readonly Claim[]
  /** Empty slots left for a human, as they appear in the text. */
  readonly placeholders: readonly string[]
  /**
   * Everything a human must settle before this can be approved: the model's own
   * list plus what the scan found. Bahasa Indonesia — it reaches the approval
   * queue (CLAUDE.md rule 8).
   */
  readonly missingInfo: readonly string[]
}

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

/**
 * The patterns, in the order their kinds are reported.
 *
 * They run over normalised text, which is why they can be this plain: the
 * normaliser has already folded "15 persen" into "15%" and "Rp 299.000" into
 * "rp299.000" on both sides of the comparison.
 *
 * `(?<![\d.,]|rp)` recurs below and does two jobs. It stops a pattern from biting
 * into the middle of a longer number — without it "Rp 299.000 bulan depan" reports
 * a "299.000 bulan" commitment nobody wrote. And because the normaliser always
 * writes the currency marker as a bare "rp" jammed against the digits, it also
 * stops the marker-less patterns from re-reporting an amount the marker-ed one
 * already claimed, which would otherwise flag "Rp 199 ribu" as ungrounded against
 * a doc that says exactly "Rp 199 ribu".
 */
const DETECTORS: ReadonlyArray<{ readonly kind: ClaimKind; readonly pattern: RegExp }> = [
  // With the marker: rp299.000 · rp5 juta · rp1,5jt
  { kind: 'currency', pattern: /rp\d[\d.,]*(?:\s?(?:ribu|juta|rb|jt))?/g },
  // Without it, carrying a magnitude word instead: "199 ribu", "1,5 juta", "299rb",
  // "2jt", "299k". This is how Indonesian sales copy normally writes a price — and
  // the prompt asks for natural sales copy, so it is the *common* case, not an edge
  // one. "m" for million is left out: it is a metre far more often than it is a
  // rupiah.
  {
    kind: 'currency',
    pattern: /(?<![\d.,]|rp)\d{1,3}(?:,\d+)?\s?(?:ribu|rb|juta|jt|k)\b/g,
  },
  // Without a marker or a magnitude word: a bare thousands-grouped number, "299.000".
  //
  // The grouping is what makes this safe enough to ship. Requiring at least one
  // "." followed by exactly three digits excludes the things a bare \d+ would have
  // swept up: years (2026), employee counts (32), outlet counts (400), ratings and
  // phone fragments. What is left is a number written the way money is written.
  // It will occasionally claim a large non-price quantity — "1.200 outlet" is
  // reported as a price — and that is the direction to be wrong in: the reviewer
  // sees the term and the sentence it came from.
  { kind: 'currency', pattern: /(?<![\d.,]|rp)\d{1,3}(?:\.\d{3})+\b/g },
  { kind: 'percentage', pattern: /\d+(?:[.,]\d+)?%/g },
  {
    kind: 'discount',
    pattern:
      /\b(?:diskon|potongan|promo|promosi|cashback|gratis|free|bonus|bebas biaya|tanpa biaya)\b/g,
  },
  // "5 hari", "24 jam", "1,5 tahun", and grouped ones like "1.500 jam". A period is
  // a thousands separator in Indonesian, never a decimal point, so the group is
  // `\.\d{3}` and the decimal is a comma.
  {
    kind: 'commitment',
    pattern: /(?<![\d.,]|rp)\d{1,3}(?:\.\d{3})*(?:,\d+)?\s?(?:jam|hari|minggu|bulan|tahun)\b/g,
  },
]

/**
 * Folds the spellings a price can arrive in into one.
 *
 * Applied identically to the draft and to the knowledge base, so a doc that says
 * "Diskon tahunan 15 persen" grounds a draft that says "diskon 15%" — and only
 * that. It does not fold 15 into 50.
 */
export function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/(\d)\s*(?:%|persen)/g, '$1%')
    .replace(/\b(?:rp|idr)\.?\s*(?=\d)/g, 'rp')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every price-shaped claim in a piece of text, deduplicated, in detector order. */
export function findClaims(text: string): readonly Claim[] {
  const normalized = normalizeForGrounding(text)
  const claims: Claim[] = []
  const seen = new Set<string>()

  for (const detector of DETECTORS) {
    for (const match of normalized.matchAll(detector.pattern)) {
      // Sentence punctuation is not part of the claim. "Rp 299.000." and
      // "Rp 299.000 per bulan" are the same amount, and a trailing full stop must
      // not be what makes a grounded price look invented.
      const term = match[0].trim().replace(/[.,]+$/, '')
      const key = `${detector.kind}:${term}`
      if (seen.has(key)) continue
      seen.add(key)
      claims.push({ kind: detector.kind, term })
    }
  }

  return claims
}

/**
 * The claims in `draft` that the knowledge base does not support verbatim.
 *
 * A workspace with no active knowledge_docs grounds nothing, so every price-shaped
 * string in the draft comes back ungrounded. That is the correct answer and not an
 * edge case: with nothing on file, there is nothing the model could have quoted.
 */
export function findUngroundedClaims(
  draft: DraftText,
  knowledge: readonly string[],
): readonly Claim[] {
  const corpus = knowledge.map(normalizeForGrounding).join('\n')
  const claims = findClaims([draft.subject, draft.body, draft.cta].join('\n'))
  return claims.filter((claim) => !isGrounded(corpus, claim))
}

/**
 * A claim grounds on its own text, and an amount written without the currency
 * marker also grounds on the same amount written with one.
 *
 * "Harga 299.000 per bulan" is supported by a doc that says "Rp 299.000 per
 * bulan" — same digits, and the doc is the side asserting it is money. Without
 * this, the marker-less detector added for informal prices would flag a draft
 * that quoted the pricelist correctly and merely dropped the "Rp".
 *
 * The reverse is deliberately NOT done. Letting "Rp 21.000" ground on a bare
 * "21.000" in a doc would accept a number that might be a quantity, a year or an
 * outlet count as a price. The safe direction is the one where the document, not
 * the draft, is the thing claiming it is money.
 */
function isGrounded(corpus: string, claim: Claim): boolean {
  if (groundsIn(corpus, claim.term)) return true
  return (
    claim.kind === 'currency' &&
    !claim.term.startsWith('rp') &&
    groundsIn(corpus, `rp${claim.term}`)
  )
}

/**
 * Whether `term` appears in `corpus` as a whole claim rather than as a fragment of
 * a larger one.
 *
 * A plain substring test is not good enough, and the way it fails is worse than a
 * miss: it *certifies* an invented number that happens to be the tail of a real
 * one. A knowledge base saying "Implementasi 21 hari kerja" would ground a draft
 * promising "1 hari" — off by twenty days, and reported as verified. Likewise "5%"
 * against a doc that says "15%".
 *
 * So a match is rejected when either side of it continues the same token:
 *
 *   - a digit or a letter directly against it, which is the "15%" / "diskonto" case;
 *   - a separator between digits, which is the "Rp 1.500" inside "Rp 1.500.000"
 *     case — a prefix of a longer amount, not the same amount.
 *
 * Ordinary punctuation and whitespace do not disqualify a match, so a price at the
 * end of a sentence in the doc still grounds a price mid-sentence in the draft.
 */
function groundsIn(corpus: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\d\\p{L}]|\\d[.,])${escaped}(?![\\d\\p{L}]|[.,]\\d)`, 'u').test(
    corpus,
  )
}

/** The empty slots a human is expected to fill, e.g. `[harga paket]`. */
export function findPlaceholders(draft: DraftText): readonly string[] {
  const matches = [draft.subject, draft.body, draft.cta]
    .join('\n')
    .matchAll(/\[[^\]\n]{2,80}\]/g)
  return [...new Set([...matches].map((match) => match[0]))]
}

// -----------------------------------------------------------------------------
// The decision
// -----------------------------------------------------------------------------

/**
 * Whether a draft may reach the approval queue as ready, and what is missing if
 * not.
 *
 * `needs_input` wins on any of three grounds, gathered rather than short-circuited
 * — a draft can be short on all three at once and the reviewer needs to see all
 * three:
 *
 *   1. a price-shaped claim with no verbatim support in active knowledge_docs,
 *      REGARDLESS of what the model reported;
 *   2. the model's own `missing_info`, when it is non-empty (SPEC §5);
 *   3. a placeholder still sitting in the text.
 *
 * There is no path to `approved` here. A human does that, and this slice does not
 * build it.
 */
export function decideDraftStatus(input: DraftDecisionInput): DraftDecision {
  const ungrounded = findUngroundedClaims(input.draft, input.knowledge)
  const placeholders = findPlaceholders(input.draft)

  const missingInfo = dedupe([
    ...input.modelMissingInfo.map((item) => item.trim()).filter((item) => item !== ''),
    ...ungrounded.map(
      (claim) =>
        `Klaim tanpa dasar di materi resmi: "${claim.term}" (${KIND_LABELS[claim.kind]}).`,
    ),
    ...placeholders.map((placeholder) => `Lengkapi bagian kosong: ${placeholder}`),
  ])

  const status: DraftStatus = missingInfo.length === 0 ? 'pending_approval' : 'needs_input'

  return { status, ungrounded, placeholders, missingInfo }
}

/** Bahasa Indonesia: these land in the approval queue (CLAUDE.md rule 8). */
const KIND_LABELS: Record<ClaimKind, string> = {
  currency: 'harga',
  percentage: 'persentase',
  discount: 'diskon atau gratis',
  commitment: 'janji waktu',
}

function dedupe(items: readonly string[]): readonly string[] {
  return [...new Set(items)]
}
