import { createHash } from 'node:crypto'

import { z } from 'zod'

import { type Result, err, ok } from '@/lib/types/result'

/**
 * `campaigns.target` — the search space one tenant is swept through (ADR 0001 §1–2).
 *
 * Pure on purpose. Nothing here imports the Drizzle handle, touches the network or
 * reads a clock, so the shape every paying client's sweep depends on is assertable
 * by `pnpm test` with no `DATABASE_URL`, no Serper key and no n8n.
 *
 * Enumeration is a pure function of the target: the same target always yields the
 * same space in the same order. That is what makes a stored cursor position mean
 * anything at all — an index is only interpretable against a space that can be
 * rebuilt exactly, which is what `fingerprintTarget` pins. When the fingerprint
 * moves, the index it belonged to is meaningless and the cursor resets.
 */

// -----------------------------------------------------------------------------
// Normalisation primitives
//
// Above the schema because the space-size refine below has to measure the
// canonical arrays, not the raw ones. One definition of "the same keyword",
// shared by validation, canonicalisation and enumeration.
// -----------------------------------------------------------------------------

/**
 * NFC first, and this is not cosmetic. "cửa hàng" typed in one editor and pasted
 * from another can be byte-different while rendering identically — NFC composes
 * the diacritic into one codepoint, NFD leaves it as two. Without this, an ops
 * person re-pasting the same Vietnamese or Indonesian keyword produces a
 * different fingerprint and silently restarts the tenant's lap.
 */
function collapseWhitespace(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ')
}

/**
 * Code-unit order, never `localeCompare`. The sort has to give the same answer on
 * every machine and under every locale, because it decides the fingerprint and the
 * fingerprint decides whether a tenant keeps its place in the space.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Normalise, drop duplicates, sort. Duplicates are dropped for the reason `pages`
 * always dropped them: two identical entries produce two byte-identical `q`
 * strings per lap, which is a second sequential Serper call whose entire result
 * set arrives as merged duplicates. Normalisation is what makes the duplicates
 * visible in the first place — "pet  shop" and "pet shop" are one keyword.
 */
function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(collapseWhitespace))].sort(byCodeUnit)
}

function canonicalPages(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/**
 * The number of searches a target actually yields, after normalisation and
 * dedupe — which is the number the tenant must be judged on. Counting the raw
 * arrays instead rejects legal targets with a message contradicting the tenant's
 * own arithmetic: `pages: [1, 1]` is one page, not two.
 *
 * It measures by calling the same two helpers `canonicalizeTarget` uses, and
 * must keep doing so. A second expression of "how many distinct keywords are
 * there really" would agree right up until somebody teaches `canonicalStrings`
 * to casefold or strip punctuation and does not mirror it here — at which point
 * the size a tenant is judged on at parse time diverges from the size actually
 * swept, which is precisely the raw-vs-canonical mismatch Amendment 1 removed.
 */
function canonicalSpaceSize(target: {
  readonly keywords: readonly string[]
  readonly locations: readonly string[]
  readonly pages: readonly number[]
}): number {
  // Typed structurally rather than as `SearchTarget`: it is called from inside
  // the schema's own refine, and naming the schema's inferred type there would
  // make the type circular.
  return (
    canonicalStrings(target.keywords).length *
    canonicalStrings(target.locations).length *
    canonicalPages(target.pages).length
  )
}

// -----------------------------------------------------------------------------
// The contract with every paying client
// -----------------------------------------------------------------------------

/** Serper bills one credit up to 10 results and two for 11–100, and returns 10 either way. */
export const RESULTS_PER_REQUEST_MAX = 10

/** keywords × locations × pages. A tenant must not be able to author a four-year lap. */
export const MAX_SPACE_SIZE = 20_000

/**
 * Serper `gl` and `hl`, exported because they are the source of truth for every
 * later bound on the same value.
 *
 * The plan endpoint used to re-state `hl` as `min(2).max(10)`, one character
 * narrower than this pattern allows. A target with an 11-character language tag
 * parsed here, allocated, advanced its cursor and then failed the response
 * schema — taking the whole estate's plan down with it, after the write had
 * committed. A second expression of the same rule is a second rule.
 */
export const COUNTRY_PATTERN = /^[a-z]{2}$/
export const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/

export const searchTargetSchema = z
  .object({
    /** Bumped only when a field's meaning changes. Parsers switch on it. */
    version: z.literal(1),
    /** Which Serper endpoint. `places` is the only one wired today. */
    endpoint: z.enum(['places', 'search']).default('places'),
    /** What the tenant sells to, in the tenant's own words. Not industry codes. */
    keywords: z.array(z.string().trim().min(2).max(120)).min(1).max(60),
    /** Free text as a human would type it into Maps. Any country, any granularity. */
    locations: z.array(z.string().trim().min(2).max(120)).min(1).max(250),
    /** Serper `page`. The ONLY lever past 10 results for one query. */
    pages: z.array(z.int().min(1).max(10)).min(1).max(10),
    /**
     * Serper `num`. Capped at 10 in the type: 11 is the credit cliff, and a
     * value that doubles the bill must not be representable.
     */
    resultsPerRequest: z.int().min(1).max(RESULTS_PER_REQUEST_MAX).default(10),
    /** Serper `gl`. ISO-3166-1 alpha-2, lowercase. Not defaulted to 'id'. */
    country: z.string().regex(COUNTRY_PATTERN),
    /** Serper `hl`. BCP-47 primary subtag. */
    language: z.string().regex(LANGUAGE_PATTERN),
    /** Optional note for the human who edits this. Never sent to Serper. */
    notes: z.string().max(500).optional(),
  })
  .refine(
    (t) => canonicalSpaceSize(t) <= MAX_SPACE_SIZE,
    { message: 'search space exceeds MAX_SPACE_SIZE' },
  )

export type SearchTarget = z.infer<typeof searchTargetSchema>

/**
 * ADR 0001 §1: an invalid or absent target is never an exception. The campaign
 * contributes zero items and appears in the plan response's `skipped` list.
 *
 * `issues` is carried so the owner can see *why* a client's target produced
 * nothing without reading a log line that no longer exists.
 */
export type TargetError = {
  readonly kind: 'invalid_target'
  readonly issues: readonly string[]
}

export function parseTarget(value: unknown): Result<SearchTarget, TargetError> {
  const parsed = searchTargetSchema.safeParse(value)
  if (!parsed.success) {
    return err({
      kind: 'invalid_target',
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.map(String).join('.')
        return path === '' ? issue.message : `${path}: ${issue.message}`
      }),
    })
  }
  return ok(parsed.data)
}

// -----------------------------------------------------------------------------
// Canonical form and the fingerprint
// -----------------------------------------------------------------------------

/**
 * ADR 0001 §2 step 1 (as amended). Normalise and collapse the free-text fields,
 * lowercase the Serper locale codes, then sort and dedupe keywords, locations and
 * pages alike.
 *
 * The key order of the literal below IS the wire format of the fingerprint:
 * `JSON.stringify` follows insertion order, so reordering these fields changes
 * every stored fingerprint and restarts every tenant's lap. Append, do not shuffle.
 *
 * Idempotent — canonicalising an already-canonical target returns the same value.
 */
export function canonicalizeTarget(target: SearchTarget): SearchTarget {
  return {
    version: target.version,
    endpoint: target.endpoint,
    keywords: canonicalStrings(target.keywords),
    locations: canonicalStrings(target.locations),
    pages: canonicalPages(target.pages),
    resultsPerRequest: target.resultsPerRequest,
    country: target.country.toLowerCase(),
    language: target.language.toLowerCase(),
    notes: target.notes,
  }
}

/**
 * ADR 0001 §2 step 3, as amended: sha256 over the canonical target *minus its
 * notes*.
 *
 * The fingerprint exists to answer one question — "is the stored position still
 * an index into this space?" So it may depend only on things that can change the
 * space. `notes` is documented one line from its own declaration as never sent to
 * Serper, so it provably cannot; hashing it meant fixing a typo in a comment
 * restarted a 90-day sweep.
 *
 * Object rest is what excludes it, deliberately rather than an explicit
 * allowlist: every key `canonicalizeTarget` returns is hashed unless it is named
 * on that line, so the default direction is "hashed", and only a field that
 * provably cannot change the space belongs there.
 *
 * That safety stops at `canonicalizeTarget`, which is itself a hand-written
 * literal. A field added to the schema but not to that literal never reaches
 * this function, and for an OPTIONAL field the compiler will not say so — the
 * literal stays assignable to `SearchTarget` with the key missing. The
 * `canonicalizeTarget covers the whole schema` case in
 * tests/unit/scraping-target.test.ts is what actually keeps the two in step;
 * without it, a new `radiusKm` would silently stop resetting cursors.
 *
 * Canonicalisation happens in here rather than at the call site so a caller cannot
 * fingerprint a raw target by accident and reset a cursor that was fine.
 */
export function fingerprintTarget(target: SearchTarget): string {
  const { notes: _notes, ...spaceIdentity } = canonicalizeTarget(target)
  return createHash('sha256').update(JSON.stringify(spaceIdentity)).digest('hex')
}

// -----------------------------------------------------------------------------
// The space
// -----------------------------------------------------------------------------

/** One Serper request, identified by where it sits in its campaign's space. */
export type SearchItem = {
  /** Position in the space. Travels to n8n as `space_index`. */
  readonly index: number
  readonly keyword: string
  readonly location: string
  readonly page: number
}

function isPrime(n: number): boolean {
  if (n < 2) return false
  if (n % 2 === 0) return n === 2
  for (let divisor = 3; divisor * divisor <= n; divisor += 2) {
    if (n % divisor === 0) return false
  }
  return true
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const remainder = x % y
    x = y
    y = remainder
  }
  return x
}

/**
 * ADR 0001 §2 step 3: the smallest prime greater than `sqrt(blockSize)` that is
 * coprime with `blockSize`.
 *
 * Coprime is the load-bearing half. It makes `j -> (j * stride) % blockSize` a
 * bijection, so a contiguous cursor window is a *mix* of keywords and locations
 * and still covers every combination exactly once per lap. "Just above sqrt" is
 * what keeps two consecutive items far apart in the lexicographic order instead
 * of adjacent.
 *
 * Total for every `blockSize >= 1`, and the degenerate cases are real rather than
 * theoretical: one keyword and one location gives 1, and 2 is the case where the
 * first candidate divides the block and has to be rejected. Termination is
 * guaranteed — `blockSize` has finitely many prime divisors and there are
 * infinitely many primes, so a coprime candidate always exists.
 */
export function strideFor(blockSize: number): number {
  // Two ways the search below never terminates, both returning the identity
  // instead. Nothing is coprime with 0, so `blockSize < 1` would spin. And a
  // non-integer is worse than it looks: `isPrime(NaN)` is true (every comparison
  // against NaN is false, so no rejection fires) and then the gcd loop runs
  // forever, because `NaN !== 0` always holds. That is a hung process, not a
  // throw. Unreachable from buildSearchSpace, where blockSize is an array
  // length — but this is exported, and the obvious next caller is a space_size
  // read back off a cursor row.
  if (!Number.isInteger(blockSize) || blockSize < 1) return 1

  // floor(sqrt(n)) + 1 is the smallest integer strictly greater than sqrt(n),
  // for a perfect square as well as for anything else.
  let candidate = Math.floor(Math.sqrt(blockSize)) + 1
  while (!isPrime(candidate) || greatestCommonDivisor(candidate, blockSize) !== 1) {
    candidate += 1
  }
  return candidate
}

/**
 * ADR 0001 §2: the deterministic, stable-ordered enumeration of a target.
 *
 * Page-major ascending — every page-1 combination before any page-2 combination —
 * because page 1 is the highest yield per credit, so a tenant's first days buy the
 * most. Inside a page block the stride permutation applies, which is what the old
 * `i % SLICES` in the n8n Search Plan node achieved by accident and what a plain
 * contiguous cursor window would have lost.
 */
export function buildSearchSpace(target: SearchTarget): readonly SearchItem[] {
  const canonical = canonicalizeTarget(target)

  const pairs: { readonly keyword: string; readonly location: string }[] = []
  for (const keyword of canonical.keywords) {
    for (const location of canonical.locations) {
      pairs.push({ keyword, location })
    }
  }

  const blockSize = pairs.length
  const stride = strideFor(blockSize)

  const items: SearchItem[] = []
  for (const page of canonical.pages) {
    for (let j = 0; j < blockSize; j += 1) {
      const pair = pairs[(j * stride) % blockSize]
      // The stride is coprime with blockSize, so the index is always in range.
      // This guard is what noUncheckedIndexedAccess needs, not a reachable branch.
      //
      // `break`, matching takeWindow, and never `continue`: because the index is
      // `items.length`, skipping one pair renumbers every item after it, and
      // every position already stored in a cursor row would then name a
      // different combination.
      //
      // `break` is the lesser evil, not a repair. It leaves only the inner loop,
      // so a multi-page target would still go on to emit renumbered later page
      // blocks; only a single-page target ends up visibly short. The real guard
      // is the exact-length assertion in the unit suite, which fails if this ever
      // fires.
      if (pair === undefined) break
      items.push({
        index: items.length,
        keyword: pair.keyword,
        location: pair.location,
        page,
      })
    }
  }
  return items
}

// -----------------------------------------------------------------------------
// The cursor's window
// -----------------------------------------------------------------------------

/** The two `scrape_cursors` columns that say where a campaign is in its space. */
export type CursorPosition = {
  /** Next index to issue. */
  readonly position: number
  /** Completed full passes over the space. */
  readonly lap: number
}

export type SearchWindow = {
  readonly items: readonly SearchItem[]
  /** Where the cursor lands afterwards — write this back to `position`. */
  readonly position: number
  /** Incremented once per wrap, so a window longer than the space counts them all. */
  readonly lap: number
}

/**
 * ADR 0001 §2 step 7: emit `count` items starting at `position`, wrapping modulo
 * the space size, and increment `lap` on every wrap.
 *
 * Total rather than fallible. An empty space, a zero count or a position left over
 * from a larger space all return a window instead of an error: the planner's answer
 * to "this campaign contributes nothing" is an empty list, never an exception.
 *
 * CALLER'S CONTRACT: `count > space.length` is honoured literally — the window
 * wraps and repeats combinations inside a single day, paying Serper twice for the
 * same query. Nothing here clamps it, because the cap belongs to the allocator
 * (ADR 0001 §3, `MAX_BATCH_PER_CAMPAIGN`), which does not exist yet. Whoever
 * writes `allocate.ts` owns that clamp.
 */
export function takeWindow(
  space: readonly SearchItem[],
  cursor: CursorPosition,
  count: number,
): SearchWindow {
  const size = space.length
  // `Number.isFinite` for the same reason strideFor tests `Number.isInteger`:
  // the function is documented total, so it has to be. Without it, Infinity
  // survives the floor and `taken < Infinity` never ends — the loop runs until
  // the push throws `RangeError: Invalid array length`. NaN is covered here too,
  // and lands on the empty-window path rather than a half-normalised position.
  const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (size === 0 || wanted === 0) {
    return { items: [], position: cursor.position, lap: cursor.lap }
  }

  // Negative-safe, and tolerant of a position that outran a shrunken space.
  let index = ((Math.trunc(cursor.position) % size) + size) % size
  let lap = cursor.lap
  const items: SearchItem[] = []

  for (let taken = 0; taken < wanted; taken += 1) {
    const item = space[index]
    // Unreachable: `index` is held inside [0, size) below. See buildSearchSpace.
    if (item === undefined) break
    items.push(item)
    index += 1
    if (index === size) {
      index = 0
      lap += 1
    }
  }

  return { items, position: index, lap }
}

/**
 * The `q` string handed to Serper. SORA composes it; n8n concatenates nothing.
 *
 * One space between the two parts, which is exactly what the `Serper Places` node
 * builds today (`$json.keyword + ' ' + $json.lokasi`), so a query issued from here
 * and a query n8n composed for itself are the same string — and therefore hit the
 * same Serper cache and the same dedupe outcome.
 *
 * Both parts come from `buildSearchSpace` and are already trimmed and collapsed.
 */
export function composeQuery(keyword: string, location: string): string {
  return `${keyword} ${location}`
}
