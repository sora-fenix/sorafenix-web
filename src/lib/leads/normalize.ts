/**
 * Canonical forms for the three fields dedupe matches on, plus the company-name
 * form used for fuzzy matching.
 *
 * Every function here is pure and total: it returns the canonical value or
 * `null`, and never throws. Callers treat `null` as "this field cannot identify
 * anything", not as an error — an item with a null phone may still be a perfectly
 * good lead reached by email.
 *
 * Extraction is deliberately NOT done here. These take one field that is already
 * meant to be a domain / phone / email and decide what it canonically is. Pulling
 * candidates out of a page of HTML is the enrichment job's problem (SPEC §3).
 */

// -----------------------------------------------------------------------------
// Domain
// -----------------------------------------------------------------------------

// A hostname: two or more dot-separated labels, letters/digits/hyphens only.
// Deliberately rejects bare IPs — an IP identifies a host, not a company.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const ALL_NUMERIC_LABELS = /^[\d.]+$/

/**
 * Names RFC 2606 and RFC 6761 reserve so they can never resolve, plus the
 * placeholder domains that show up in scraped markup.
 *
 * This guard is load-bearing, not tidiness. A scraper that emits a sentinel for
 * "this business has no website" — n8n's lead hunter uses `no-website.invalid`
 * exactly this way — would otherwise hand every website-less company the same
 * domain, and the domain strategy would merge all of them into one company on
 * the first import.
 */
const RESERVED_DOMAIN =
  /(?:^|\.)(?:test|example|invalid|localhost)$|^example\.(?:com|net|org)$/

/**
 * Strips protocol, credentials, `www.`, port, path, query and fragment, and
 * lowercases what is left. `HTTPS://WWW.PetShop.co.id/kontak?a=1` → `petshop.co.id`.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null

  let value = input.trim().toLowerCase()
  if (value === '') return null

  // Order matters: strip the scheme before the path, or `//` reads as a path.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  // user:pass@host
  const at = value.lastIndexOf('@')
  if (at !== -1) value = value.slice(at + 1)
  // Everything from the first path/query/fragment separator onward.
  value = value.split(/[/?#]/, 1)[0] ?? ''
  // Port.
  value = value.replace(/:\d+$/, '')
  // A fully-qualified name may end in a dot; it is the same host.
  value = value.replace(/\.$/, '')
  value = value.replace(/^www\./, '')

  if (value === '' || !HOSTNAME.test(value)) return null
  if (ALL_NUMERIC_LABELS.test(value)) return null
  if (RESERVED_DOMAIN.test(value)) return null

  return value
}

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/

/**
 * Lowercases and trims, and drops punctuation that commonly rides along when an
 * address is scraped out of a sentence (`info@toko.co.id.` / `(sales@toko.id)`).
 *
 * Shape only. Noise filtering — `noreply@`, `sentry.io`, tracking pixels — belongs
 * to enrichment, where the addresses come from untrusted page text.
 */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null

  let value = input.trim().toLowerCase()
  if (value === '') return null

  value = value.replace(/^mailto:/, '')
  value = value.replace(/^[<("'[]+/, '').replace(/[>)"'\].,;:]+$/, '')

  if (!EMAIL.test(value)) return null
  // A second @ survives the regex only via the local part; reject outright.
  if (value.split('@').length !== 2) return null

  return value
}

// -----------------------------------------------------------------------------
// Phone
// -----------------------------------------------------------------------------

/**
 * Indonesian national significant number: the part after the +62.
 *
 * First digit 2-9 — 0 is the trunk prefix and 1 is reserved for short codes, so
 * neither can start a real subscriber number. Length 7-12 covers both ends of the
 * plan: a small-town landline (`+62 274 123456`) and a 12-digit mobile.
 */
const NSN = /^[2-9]\d{6,11}$/

/**
 * Collapses every Indonesian phone form we see in the wild to one E.164 string.
 *
 *   0812-3456-7890 · +62 812 3456 7890 · 62 812 3456 7890 · 8123456789
 *   +62 (0) 812 3456 7890 · 0062 812 ... · (021) 555-1234
 *   → +6281234567890 / +62215551234
 *
 * **Landlines count.** A business office number is a lawful business contact
 * under our outreach rule, and Google Maps returns them constantly, so `+62 31 …`
 * must survive. That is why this is wider than the `08xx` mobile-only rule in
 * SPEC §2 — the SPEC text lists the mobile forms as examples, not as the limit.
 *
 * Only `+62` / `62` / `0` / `8` openings are accepted. Anything else returns null,
 * which is what keeps a price like `Rp 62.000.000` from being read as a number:
 * it opens with `62`, so the only reading is a country code, and what follows
 * (`000000`) is not a valid subscriber number.
 *
 * Known limit: a doubled country code (`+6262812…`) and a hypothetical landline
 * whose area code is literally `62` are indistinguishable. We peel repeatedly,
 * which is right for the first — the case that actually occurs in scraped data —
 * and wrong for the second, which does not appear in Indonesia's numbering plan.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null

  const trimmed = input.trim()
  if (trimmed === '') return null

  // An extension turns one number into two; we keep the main line.
  const withoutExtension = trimmed.split(/\b(?:ext|extension|x)\b/i, 1)[0] ?? trimmed

  let digits = withoutExtension.replace(/\D/g, '')
  if (digits === '') return null

  // 00 is the international access prefix: 0062… is +62…
  if (digits.startsWith('00')) digits = digits.slice(2)

  let nsn: string
  if (digits.startsWith('62')) {
    while (digits.startsWith('62')) digits = digits.slice(2)
    // `+62 (0) 812 …` — the trunk prefix written alongside the country code.
    nsn = digits.replace(/^0+/, '')
  } else if (digits.startsWith('0')) {
    nsn = digits.replace(/^0+/, '')
  } else if (digits.startsWith('8')) {
    nsn = digits
  } else {
    return null
  }

  if (!NSN.test(nsn)) return null

  return `+62${nsn}`
}

/** True for a number in the mobile range, the only range WhatsApp can reach. */
export function isMobilePhone(e164: string | null): boolean {
  return e164 !== null && e164.startsWith('+628')
}

// -----------------------------------------------------------------------------
// Company name
// -----------------------------------------------------------------------------

// Indonesian legal forms. Written and matched separately from the name so that
// "PT Maju Bersama" and "Maju Bersama Digital" can still be compared.
const LEGAL_FORMS = /^(?:pt|cv|ud|pd|fa|firma|koperasi|kop|yayasan|perum|persero|tbk)\.?\s+/i
const LEGAL_SUFFIXES = /\s+(?:tbk|persero)\.?$/i

/**
 * The form fuzzy matching compares. Legal form, punctuation and spacing are
 * stripped so the trigram score reflects the actual trading name — otherwise
 * every "PT …" in a workspace shares a prefix and scores misleadingly alike.
 *
 * Returns an empty string when nothing is left, which callers must treat as
 * "not comparable" rather than as a value that could match another empty one.
 */
export function normalizeCompanyName(input: string | null | undefined): string {
  if (input === null || input === undefined) return ''

  let value = input.trim().toLowerCase()
  if (value === '') return ''

  value = value.replace(LEGAL_FORMS, '')
  value = value.replace(LEGAL_SUFFIXES, '')
  value = value.replace(/[^\p{L}\p{N}\s]/gu, ' ')
  value = value.replace(/\s+/g, ' ').trim()

  return value
}

/** City, for the fuzzy pair. Same treatment, minus the legal forms. */
export function normalizeCity(input: string | null | undefined): string {
  if (input === null || input === undefined) return ''
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
