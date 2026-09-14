import {
  isMobilePhone,
  normalizeCity,
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from './normalize'

/**
 * Duplicate detection for incoming leads (SPEC §2).
 *
 * The four strategies are tried **in order, first hit wins**. That order is not
 * arbitrary and must not be reshuffled for convenience: it runs from the
 * identifier that is hardest to share by accident to the one that is easiest.
 * Two businesses never share a domain; they routinely share a receptionist's
 * phone in a shared office, and they very often have similar names in the same
 * city. Matching on the weakest signal first would merge companies that are not
 * the same company, and a merged company is not something the product can undo.
 *
 * The lookups are injected rather than imported. That keeps every ordering rule
 * — including "a domain hit wins even when the phone points somewhere else" —
 * unit-testable with no database, which is what `.claude/rules/testing.md`
 * requires of this file.
 */

export type MatchStrategy = 'domain' | 'phone' | 'email' | 'fuzzy_name_city'

/** SPEC §2: trigram similarity at or above this counts as the same company. */
export const FUZZY_THRESHOLD = 0.85

/** One item as it arrives from n8n or a CSV row, before any normalisation. */
export type RawLead = {
  companyName: string
  website?: string | null
  city?: string | null
  address?: string | null
  phone?: string | null
  whatsapp?: string | null
  email?: string | null
  category?: string | null
  sourceUrl?: string | null
  /** Google Maps rating, 1.0-5.0, as the scraper read it. */
  rating?: number | null
  reviewCount?: number | null
}

/** The same item once every identifier is in canonical form. */
export type NormalizedLead = {
  companyName: string
  /** Legal form and punctuation stripped — what fuzzy matching compares. */
  comparableName: string
  comparableCity: string
  city: string | null
  address: string | null
  website: string | null
  domain: string | null
  phone: string | null
  whatsapp: string | null
  email: string | null
  category: string | null
  sourceUrl: string | null
  rating: number | null
  reviewCount: number | null
}

export function normalizeLead(raw: RawLead): NormalizedLead {
  const phone = normalizePhone(raw.phone)
  const whatsapp = normalizePhone(raw.whatsapp)
  const website = raw.website?.trim() ?? ''
  const city = raw.city?.trim() ?? ''
  const address = raw.address?.trim() ?? ''
  const category = raw.category?.trim() ?? ''
  const sourceUrl = raw.sourceUrl?.trim() ?? ''

  return {
    companyName: raw.companyName.trim(),
    comparableName: normalizeCompanyName(raw.companyName),
    comparableCity: normalizeCity(raw.city),
    city: city === '' ? null : city,
    address: address === '' ? null : address,
    website: website === '' ? null : website,
    domain: normalizeDomain(raw.website),
    phone,
    // A landline in the WhatsApp column is a data-entry mistake, not a WA number.
    whatsapp: isMobilePhone(whatsapp) ? whatsapp : null,
    email: normalizeEmail(raw.email),
    category: category === '' ? null : category,
    sourceUrl: sourceUrl === '' ? null : sourceUrl,
    rating: normalizeRating(raw.rating),
    reviewCount: normalizeReviewCount(raw.reviewCount),
  }
}

/**
 * A rating we are willing to store, or null.
 *
 * Out of range is dropped rather than clamped. A 7.3 did not come from Google, so
 * clamping it to 5.0 would hand the best possible reputation score to the one row
 * whose data we trust least — and `src/lib/scoring/signals.ts` treats null as
 * "unknown", which scores neutral. Rounded to one decimal because that is what the
 * column stores; doing it here means the value the rubric sees and the value the
 * database holds are the same number.
 */
function normalizeRating(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value <= 0 || value > 5) return null
  return Math.round(value * 10) / 10
}

function normalizeReviewCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * SPEC §2: "Reject rows with no website AND no phone AND no email. They are not
 * leads." Checked against the **normalised** values on purpose — a website of
 * `n/a` or a phone of `-` survives a trimmed-string test and does not survive
 * this one.
 *
 * `website` rather than `domain`: a reachable URL we cannot parse into a domain
 * is still a way to reach the business, and enrichment may yet make sense of it.
 */
export function isContactable(lead: NormalizedLead): boolean {
  return lead.website !== null || lead.phone !== null || lead.email !== null
}

/**
 * The value stored in `companies.dedupe_key` — the strongest identifier this
 * company actually has, so a later import can find it cheaply.
 *
 * This is ours, computed from our own normalisation. A `dedupe_key` that arrives
 * inside a webhook payload is never trusted for identity: it was computed by
 * someone else's rules, over a single run, and identity is not something we let
 * a caller assert.
 */
export function dedupeKeyFor(lead: NormalizedLead): string | null {
  if (lead.domain !== null) return `domain:${lead.domain}`
  if (lead.phone !== null) return `phone:${lead.phone}`
  if (lead.email !== null) return `email:${lead.email}`
  if (lead.comparableName !== '') return `name:${lead.comparableName}`
  return null
}

/**
 * Workspace-scoped lookups. Every implementation MUST filter by `workspace_id`:
 * the Drizzle connection bypasses RLS, so this interface is the boundary where a
 * missing filter becomes a cross-tenant leak (CLAUDE.md rule 6).
 *
 * Each returns the id of the matching company, or null.
 */
export type CompanyLookup = {
  byDomain(domain: string): Promise<string | null>
  byPhone(phone: string): Promise<string | null>
  byEmail(email: string): Promise<string | null>
  byFuzzyNameCity(
    comparableName: string,
    comparableCity: string,
    threshold: number,
  ): Promise<string | null>
}

export type DuplicateMatch = {
  companyId: string
  strategy: MatchStrategy
  /** The value that matched, for the audit trail. */
  matchedOn: string
}

/**
 * Runs the four strategies in SPEC order and stops at the first hit.
 *
 * Fuzzy matching needs **both** a name and a city. Name alone is not enough:
 * "Toko Bahagia" exists in a dozen cities and they are a dozen businesses.
 */
export async function findDuplicate(
  lookup: CompanyLookup,
  lead: NormalizedLead,
): Promise<DuplicateMatch | null> {
  if (lead.domain !== null) {
    const id = await lookup.byDomain(lead.domain)
    if (id !== null) return { companyId: id, strategy: 'domain', matchedOn: lead.domain }
  }

  // The WhatsApp number is a phone too, and is frequently the only one a small
  // business publishes. Checked after the main line, still under this strategy.
  for (const candidate of [lead.phone, lead.whatsapp]) {
    if (candidate === null) continue
    const id = await lookup.byPhone(candidate)
    if (id !== null) return { companyId: id, strategy: 'phone', matchedOn: candidate }
  }

  if (lead.email !== null) {
    const id = await lookup.byEmail(lead.email)
    if (id !== null) return { companyId: id, strategy: 'email', matchedOn: lead.email }
  }

  if (lead.comparableName !== '' && lead.comparableCity !== '') {
    const id = await lookup.byFuzzyNameCity(
      lead.comparableName,
      lead.comparableCity,
      FUZZY_THRESHOLD,
    )
    if (id !== null) {
      return {
        companyId: id,
        strategy: 'fuzzy_name_city',
        matchedOn: `${lead.comparableName} @ ${lead.comparableCity}`,
      }
    }
  }

  return null
}
