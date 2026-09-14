/**
 * Deterministic lead classification from scraped place signals.
 *
 * The companion to `rubric.ts`, not a replacement for it. `rubric.ts` bands what a
 * model judged about fit against a product; this file bands what the scrape itself
 * measured — review volume, rating, reachable channels, a website, the category
 * and the city. No model is involved anywhere in this file, and that is the point:
 *
 *   * every one of the six factors is a fact already in a column, so there is
 *     nothing for a model to be wrong about;
 *   * 1200 leads classify in seconds instead of hours, and re-classify for free;
 *   * the same row scored twice a month apart gives the same number.
 *
 * It exists because the LLM rubric cannot see any of this. `lib/scoring/score.ts`
 * hands the model name, industry, city, size band, employee count and description
 * — a Google Maps rating and a review count reach it through no path at all. And
 * in a workspace with no `products` row, `industry_fit` and `product_need` (half
 * the weight in SPEC §4) are pinned to neutral, so the model decides a lead on the
 * remaining 50 points while knowing nothing about the business.
 *
 * Nothing here does I/O and nothing here imports outside the module, so every band
 * edge is testable without a database, a key or a network — which
 * `.claude/rules/testing.md` requires of `src/lib/scoring/*`.
 *
 * The bands themselves are NOT redefined here. `categoryFor`, `HOT_FLOOR`,
 * `WARM_FLOOR` and `NEUTRAL_SCORE` are imported from `rubric.ts` so a score of 62
 * means the same thing whichever rubric produced it.
 */

import { NEUTRAL_SCORE, type LeadCategory, categoryFor } from './rubric'

/** Names the rubric that produced a score, since both write `leads.score`. */
export const SIGNAL_RUBRIC = 'signals_v1'

export const SIGNAL_FACTOR_KEYS = [
  'review_volume',
  'review_quality',
  'contactability',
  'web_presence',
  'category_fit',
  'location',
] as const

export type SignalFactorKey = (typeof SIGNAL_FACTOR_KEYS)[number]

export type SignalFactorSpec = {
  readonly key: SignalFactorKey
  /** Bahasa Indonesia — a salesperson reads this, not a developer. */
  readonly label: string
  readonly weight: number
}

/**
 * The six factors and their weights.
 *
 * Weighted by measured discriminating power over the 1208 scraped rows in
 * `data-riil`, not by intuition. Two numbers decided the shape:
 *
 *   * review count spreads the population — p25 6, p50 21, p75 77, p90 221 — so it
 *     carries the most weight;
 *   * a phone number does not. 1206 of 1208 rows have one, and 0 have an email.
 *     A factor every lead scores identically on sorts nothing, which is why
 *     `contactability` sits at 20 rather than the 40 "has a contact channel"
 *     sounds like it deserves.
 *
 * They sum to 100, and `signalWeightsSumTo100()` makes that a test rather than a
 * comment.
 */
export const SIGNAL_FACTORS: readonly SignalFactorSpec[] = [
  { key: 'review_volume', label: 'Volume review', weight: 30 },
  { key: 'review_quality', label: 'Kualitas rating', weight: 20 },
  { key: 'contactability', label: 'Kemudahan dihubungi', weight: 20 },
  { key: 'web_presence', label: 'Kehadiran online', weight: 15 },
  { key: 'category_fit', label: 'Kecocokan kategori', weight: 10 },
  { key: 'location', label: 'Lokasi', weight: 5 },
]

/** One factor as it is stored in `leads.score_factors`. */
export type StoredSignalFactor = {
  readonly key: SignalFactorKey
  readonly label: string
  readonly weight: number
  /** 0–100. */
  readonly score: number
  /** One sentence, Bahasa Indonesia, naming the stored fact it rests on. */
  readonly evidence: string
}

export type SignalBreakdown = {
  readonly score: number
  readonly category: LeadCategory
  readonly factors: readonly StoredSignalFactor[]
  /** 2–3 sentences, Bahasa Indonesia, for the lead list. */
  readonly reason: string
  readonly rubric: typeof SIGNAL_RUBRIC
}

/**
 * Everything the classifier is allowed to look at. Every field is a stored column
 * — `companies.*` plus the lead's `contacts` row — and never a derived guess.
 */
export type LeadSignals = {
  readonly rating: number | null
  readonly reviewCount: number | null
  readonly website: string | null
  readonly domain: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly whatsapp: string | null
  readonly city: string | null
  /** `companies.industry` — the Google Maps category, verbatim. */
  readonly category: string | null
}

// -----------------------------------------------------------------------------
// Tuning constants — every one of them is asserted by the unit suite
// -----------------------------------------------------------------------------

/**
 * The review count at which `review_volume` reaches 100.
 *
 * 250 sits just above the observed p90 of 221, so the top decile of the scraped
 * population lands near the ceiling and the 980-review outlier does not compress
 * everyone else into the bottom of the scale.
 */
export const REVIEW_SATURATION = 250

/**
 * Below this many reviews a rating is not evidence, and `review_quality` returns
 * neutral instead of a number. Five is the point where a single angry customer
 * stops being able to move the average by more than half a star.
 */
export const MIN_REVIEWS_FOR_RATING = 5

/** At or above this many reviews the rating is taken at face value. */
export const FULL_CONFIDENCE_REVIEWS = 20

/**
 * The rating window `review_quality` stretches across.
 *
 * Google ratings cluster hard at the top — in `data-riil` p25 is 4.6, p50 4.8 and
 * p75 5.0. Mapping 1.0–5.0 linearly would score essentially every lead above 90
 * and rank nothing. The window is therefore 3.5–5.0: below 3.5 a business has a
 * real reputation problem and scores 0, and the half-star that separates a good
 * shop from an average one spans the whole scale instead of 12 points of it.
 */
export const RATING_FLOOR = 3.5
export const RATING_CEILING = 5.0

/** The highest rating Google publishes. Anything above it is corrupt input. */
const MAX_VALID_RATING = 5

/**
 * Words that mark a Google Maps category as an animal business.
 *
 * A keyword allowlist rather than a list of exact categories, because the sweep
 * keeps running: Serper has already produced 51 distinct category strings across
 * six cities, and a new one appearing next week must be judged on its merits
 * rather than slipping through as "not on the list, so neutral". Matching is done
 * on a lowercased, accent-free form, so `Kafe kucing` and `Kafe Kucing` agree.
 *
 * Each word is matched at a word BOUNDARY, not as a bare substring. `Jasa
 * Perbaikan Telepon` contains `ikan` and a substring match scored it a perfect
 * category fit — a phone repair shop judged an animal business. The boundary is
 * only at the front, so a suffix still matches (`ikan` finds `ikannya`); a prefix
 * does not, which is why `peternak` is listed next to `ternak` rather than
 * relying on one to find the other.
 *
 * Per the owner's decision (2026-09-13): everything with an animal signal is in
 * scope — retail, grooming, boarding, breeders and vets alike. Only categories
 * with no animal signal at all are marked out of scope: `Toko`, `Toko umum`,
 * `Minimarket`, `Pusat Perbelanjaan`, `Klinik Medis`, `Dokter`, `Vila`, `Pasar`
 * and the like, around 42 of the 1208 rows.
 */
const PET_KEYWORDS = [
  'hewan',
  'peliharaan',
  'petshop',
  'pet shop',
  'kucing',
  'anjing',
  'burung',
  'unggas',
  'ikan',
  'akuarium',
  'aquarium',
  'reptil',
  'perikanan',
  'pakan',
  'ternak',
  'peternak',
  'satwa',
  'groom',
  'vet',
] as const

/**
 * The allowlist as one boundary-anchored expression, built once at module load
 * rather than per lead — this runs 1200 times in a sweep.
 */
// String.raw, not a plain template literal: `\b` in a normal template literal is
// the backspace character, so the expression would match nothing at all while
// still compiling and still reading as correct.
const PET_CATEGORY = new RegExp(String.raw`\b(?:${PET_KEYWORDS.join('|')})`, 'u')

/**
 * City tiers, scored by how close a business sits to the sweep's centre of
 * gravity — Surabaya Raya first, Malang Raya second.
 *
 * This is the one factor here resting on an assumption rather than a measurement,
 * which is exactly why it carries the smallest weight in the table (5). When
 * `data-riil` gets a `products` row with a real ICP, or a campaign carries a
 * target territory, this table should be read from there instead of being a
 * constant. A city we do not recognise scores neutral, never low — an unfamiliar
 * city is missing information, not a bad address.
 */
const CITY_TIERS: ReadonlyMap<string, number> = new Map([
  ['surabaya', 100],
  ['sidoarjo', 90],
  ['gresik', 80],
  ['mojokerto', 65],
  ['malang', 75],
  ['batu', 65],
])

// -----------------------------------------------------------------------------
// The classifier
// -----------------------------------------------------------------------------

/**
 * Weighted total, banded, with the factor rows and the salesperson-facing reason.
 *
 * Total. It never throws and never returns a partial result: a field it cannot
 * read scores `NEUTRAL_SCORE` and says so in its evidence, the same rule
 * `rubric.ts` applies to an ungrounded model answer (SPEC §4).
 */
export function classifySignals(signals: LeadSignals): SignalBreakdown {
  const scored: Record<SignalFactorKey, Scored> = {
    review_volume: reviewVolume(signals.reviewCount),
    review_quality: reviewQuality(signals.rating, signals.reviewCount),
    contactability: contactability(signals),
    web_presence: webPresence(signals),
    category_fit: categoryFit(signals.category),
    location: location(signals.city),
  }

  const factors: StoredSignalFactor[] = SIGNAL_FACTORS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    weight: spec.weight,
    score: scored[spec.key].score,
    evidence: scored[spec.key].evidence,
  }))

  // Weights sum to 100, so dividing by 100 puts the total back on a 0–100 scale.
  const weighted = factors.reduce((total, factor) => total + factor.score * factor.weight, 0)
  const score = Math.round(weighted / 100)

  return {
    score,
    category: categoryFor(score),
    factors,
    reason: buildReason(score, factors),
    rubric: SIGNAL_RUBRIC,
  }
}

/** Guards the invariant the whole scale rests on. Asserted by the unit suite. */
export function signalWeightsSumTo100(): boolean {
  return SIGNAL_FACTORS.reduce((total, factor) => total + factor.weight, 0) === 100
}

// -----------------------------------------------------------------------------
// Factors
// -----------------------------------------------------------------------------

type Scored = { readonly score: number; readonly evidence: string }

/**
 * How much traffic the business has actually seen, log-scaled.
 *
 * Log rather than linear because the difference between 5 reviews and 50 says far
 * more about a business than the difference between 500 and 550. Linear would
 * hand the top decile the entire usable range and flatten everyone else to single
 * digits.
 *
 * Zero reviews scores 0, not neutral: "nobody has ever reviewed this place" is a
 * measurement, not a gap in our data. A missing count is the gap, and that is what
 * scores neutral.
 */
function reviewVolume(reviewCount: number | null): Scored {
  const count = wholeCount(reviewCount)
  if (count === null) {
    return {
      score: NEUTRAL_SCORE,
      evidence: 'Jumlah review tidak tersedia di data, jadi faktor ini dinilai netral.',
    }
  }

  if (count === 0) {
    return { score: 0, evidence: 'Belum ada satu pun review di Google Maps.' }
  }

  const ratio = Math.log1p(count) / Math.log1p(REVIEW_SATURATION)
  return {
    score: clamp(ratio * 100),
    evidence: `Punya ${count} review di Google Maps.`,
  }
}

/**
 * The rating, worth only as much as the volume behind it.
 *
 * A 5.0 from two customers and a 4.6 from three hundred are not the same claim,
 * and scoring them the same is the mistake this factor exists to avoid. The
 * stretched rating is pulled back toward neutral in proportion to how far the
 * review count falls short of `FULL_CONFIDENCE_REVIEWS`, so thin evidence moves
 * the score a little and strong evidence moves it all the way.
 */
function reviewQuality(rating: number | null, reviewCount: number | null): Scored {
  if (rating === null || !Number.isFinite(rating) || rating <= 0 || rating > MAX_VALID_RATING) {
    return {
      score: NEUTRAL_SCORE,
      evidence: 'Rating tidak tersedia di data, jadi faktor ini dinilai netral.',
    }
  }

  const shown = formatRating(rating)
  const count = wholeCount(reviewCount)

  if (count === null) {
    return {
      score: NEUTRAL_SCORE,
      evidence: `Rating ${shown} tercatat, tapi jumlah reviewnya tidak diketahui, jadi belum bisa dipakai.`,
    }
  }

  if (count < MIN_REVIEWS_FOR_RATING) {
    return {
      score: NEUTRAL_SCORE,
      evidence: `Rating ${shown} hanya dari ${count} review, terlalu sedikit untuk jadi bukti.`,
    }
  }

  const span = RATING_CEILING - RATING_FLOOR
  const stretched = clamp(((rating - RATING_FLOOR) / span) * 100)
  const confidence = Math.min(count, FULL_CONFIDENCE_REVIEWS) / FULL_CONFIDENCE_REVIEWS
  const score = clamp(NEUTRAL_SCORE + (stretched - NEUTRAL_SCORE) * confidence)

  const note =
    confidence < 1
      ? ` (baru ${count} review, jadi bobotnya belum penuh)`
      : ` dari ${count} review`
  return { score, evidence: `Rating ${shown}${note}.` }
}

/**
 * How we would actually reach them, best channel first.
 *
 * WhatsApp outranks a landline because it is the channel this market answers, and
 * because it is the one our own outreach can use. Email adds on top of either
 * rather than replacing it.
 *
 * A lead with no channel at all scores near zero rather than neutral: ingestion
 * only accepts a row with a website, a phone or an email (SPEC §2), so "nothing
 * here" means the one thing it had was a website — which `web_presence` already
 * counts.
 */
function contactability(signals: LeadSignals): Scored {
  const hasWhatsapp = filled(signals.whatsapp)
  const hasPhone = filled(signals.phone)
  const hasEmail = filled(signals.email)

  if (hasWhatsapp && hasEmail) {
    return { score: 100, evidence: 'Ada nomor WhatsApp dan alamat email.' }
  }
  if (hasWhatsapp) {
    return { score: 85, evidence: 'Ada nomor WhatsApp yang bisa langsung dihubungi.' }
  }
  if (hasPhone && hasEmail) {
    return { score: 75, evidence: 'Ada nomor telepon dan alamat email, tapi bukan WhatsApp.' }
  }
  if (hasPhone) {
    return { score: 60, evidence: 'Hanya ada nomor telepon, belum ada WhatsApp atau email.' }
  }
  if (hasEmail) {
    return { score: 45, evidence: 'Hanya ada alamat email, belum ada nomor yang bisa dihubungi.' }
  }
  return { score: 5, evidence: 'Belum ada nomor maupun email yang tercatat.' }
}

/**
 * Whether the business exists online beyond its Maps listing.
 *
 * Rare in this segment — 71 of 1208 — which is precisely what makes it worth
 * points: a petshop that bothered to put up a site is running a business that
 * thinks about channels. Having none scores low but not zero, because in a market
 * where 94% have no site it is weak evidence, not a disqualification.
 */
function webPresence(signals: LeadSignals): Scored {
  if (filled(signals.domain)) {
    return { score: 100, evidence: `Punya website sendiri (${signals.domain}).` }
  }
  if (filled(signals.website)) {
    return { score: 70, evidence: 'Ada alamat website, tapi domainnya belum terbaca rapi.' }
  }
  return { score: 20, evidence: 'Belum punya website, hanya listing Google Maps.' }
}

/**
 * Whether the Google Maps category describes an animal business at all.
 *
 * A missing category scores neutral; a present category that carries no animal
 * signal scores low, because that is a judgement about a fact we hold, not a gap.
 */
function categoryFit(category: string | null): Scored {
  if (!filled(category)) {
    return {
      score: NEUTRAL_SCORE,
      evidence: 'Kategori usaha tidak tercatat, jadi faktor ini dinilai netral.',
    }
  }

  const matched = PET_CATEGORY.test(foldForMatch(category))

  return matched
    ? { score: 100, evidence: `Kategorinya "${category.trim()}" — usaha hewan peliharaan.` }
    : {
        score: 20,
        evidence: `Kategorinya "${category.trim()}", tidak menunjukkan usaha hewan peliharaan.`,
      }
}

/** Proximity to the territory the sweep actually covers. */
function location(city: string | null): Scored {
  if (!filled(city)) {
    return {
      score: NEUTRAL_SCORE,
      evidence: 'Kota tidak tercatat, jadi faktor ini dinilai netral.',
    }
  }

  const tier = CITY_TIERS.get(foldForMatch(city))
  if (tier === undefined) {
    return {
      score: NEUTRAL_SCORE,
      evidence: `Ada di ${city.trim()}, di luar wilayah sapuan saat ini.`,
    }
  }

  return { score: tier, evidence: `Ada di ${city.trim()}.` }
}

// -----------------------------------------------------------------------------
// The reason a salesperson reads
// -----------------------------------------------------------------------------

/** At or above this much neutral weight, the score is provisional and says so. */
const MOSTLY_UNKNOWN_WEIGHT = 50

const BAND_OPENER: Readonly<Record<LeadCategory, string>> = {
  hot: 'Prospek kuat, layak dihubungi lebih dulu.',
  warm: 'Prospek menengah, layak dihubungi setelah yang panas.',
  cold: 'Prospek lemah untuk sekarang.',
}

/**
 * Two or three sentences built from the factors that actually moved the number.
 *
 * Assembled from the same evidence strings the breakdown stores, so the summary
 * can never claim something the factor rows do not. "Moved the number" means
 * weighted distance from neutral, which is why a perfect score on a 5-point factor
 * does not outrank a middling one on a 30-point factor.
 */
function buildReason(score: number, factors: readonly StoredSignalFactor[]): string {
  const byImpact = [...factors].sort(
    (a, b) => impact(b) - impact(a),
  )

  const strongest = byImpact.filter((factor) => factor.score > NEUTRAL_SCORE).slice(0, 2)
  const weakest = [...factors]
    .filter((factor) => factor.score < NEUTRAL_SCORE)
    .sort((a, b) => impact(b) - impact(a))
    .slice(0, 1)

  const sentences = [`${BAND_OPENER[categoryFor(score)]} Skor ${score}/100.`]

  if (strongest.length > 0) {
    sentences.push(`Yang menguatkan: ${joinEvidence(strongest)}`)
  }
  if (weakest.length > 0) {
    sentences.push(`Yang melemahkan: ${joinEvidence(weakest)}`)
  }

  // When most of the weight sat on factors we had no data for, the number is a
  // placeholder and the salesperson has to be told so. Without this sentence a
  // lead scores 37 and reads as judged, when it was only ever unmeasured.
  const neutralWeight = factors
    .filter((factor) => factor.score === NEUTRAL_SCORE)
    .reduce((total, factor) => total + factor.weight, 0)
  if (neutralWeight >= MOSTLY_UNKNOWN_WEIGHT) {
    sentences.push(
      `Sebagian besar data pendukung belum lengkap (${neutralWeight} dari 100 bobot), jadi skor ini masih sementara.`,
    )
  }

  return sentences.join(' ')
}

function impact(factor: StoredSignalFactor): number {
  return Math.abs(factor.score - NEUTRAL_SCORE) * factor.weight
}

function joinEvidence(factors: readonly StoredSignalFactor[]): string {
  return factors
    .map((factor) => lowerFirst(stripTrailingDot(factor.evidence)))
    .join('; ')
    .concat('.')
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function clamp(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL_SCORE
  return Math.min(Math.max(Math.round(value), 0), 100)
}

/** A review count we can do arithmetic on, or null for "we do not know". */
function wholeCount(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

/**
 * A type predicate rather than a plain boolean, so the caller that just proved a
 * value is present can use it without a non-null assertion — which rule 9 forbids
 * and eslint rejects.
 */
function filled(value: string | null): value is string {
  return value !== null && value.trim() !== ''
}

/** Lowercased and accent-free, so `Kafe kucing` and `Kafé Kucing` match alike. */
function foldForMatch(value: string): string {
  return value
    .normalize('NFD')
    // The combining-marks block, stripped by code point rather than by pasting
    // the marks themselves — they are invisible in a diff and easy to lose.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** `4.7` not `4.7000000000000002`, and `5` not `5.0`. */
function formatRating(rating: number): string {
  return String(Math.round(rating * 10) / 10)
}

function stripTrailingDot(sentence: string): string {
  return sentence.replace(/\.+$/, '')
}

function lowerFirst(sentence: string): string {
  const first = sentence.charAt(0)
  const second = sentence.charAt(1)
  // An acronym keeps its shape. Nothing in this file currently opens with one,
  // but the guard costs a line and an evidence string added later might.
  if (first === '' || second === second.toUpperCase()) {
    if (second !== second.toLowerCase()) return sentence
  }
  return first.toLowerCase() + sentence.slice(1)
}
