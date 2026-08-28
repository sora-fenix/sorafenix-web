import { normalizeCompanyName } from '@/lib/leads/normalize'

/**
 * Workspace name → URL slug.
 *
 * The slug is the workspace's address (`/app/{slug}/dashboard`), so it has to be
 * ASCII, lowercase and free of anything a router or a human retyping a link
 * would mangle.
 *
 * Legal-form stripping is delegated to `normalizeCompanyName` rather than
 * repeated here. That function already decides what "PT Maju Bersama" is really
 * called, and a second copy of that judgement would drift from the first — the
 * same reasoning that made `companies.name_normalized` a stored column.
 */

/** Longest slug we will generate, before any uniqueness suffix. */
const MAX_LENGTH = 48

/** Fallback when a name normalises away to nothing (e.g. "!!!"). */
const FALLBACK = 'workspace'

/**
 * Slugs that would shadow a route. `/app/{slug}` sits next to the `/app` index,
 * and Next.js resolves a literal segment before the `[workspace]` dynamic one —
 * so a workspace called `new` would become unreachable the day someone adds
 * `/app/new`. Reserving them now costs nothing; discovering it later costs a
 * migration of live URLs.
 */
const RESERVED = new Set([
  'api',
  'app',
  'auth',
  'login',
  'logout',
  'new',
  'settings',
  'admin',
  'static',
  '_next',
])

/** Combining marks left behind by NFD decomposition. */
const COMBINING_MARKS = /[̀-ͯ]/g

/**
 * Folds the accents that survive `normalizeCompanyName`'s `\p{L}` class.
 * Indonesian rarely needs this; a pasted "Café Nusantara" does.
 */
function toAscii(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9\s]/g, '')
}

/**
 * Never throws and never returns an empty string, so a caller always has
 * something to insert. Uniqueness is not this function's job — the database
 * decides that, and `provisionWorkspace` handles the collision.
 */
export function slugifyWorkspaceName(name: string): string {
  const normalized = toAscii(normalizeCompanyName(name))
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  if (normalized === '') return FALLBACK

  // Trim on a separator so the slug never ends mid-word with a dangling dash.
  const clamped = normalized.slice(0, MAX_LENGTH).replace(/-$/, '')
  if (clamped === '') return FALLBACK

  return RESERVED.has(clamped) ? `${clamped}-1` : clamped
}

/**
 * The nth candidate for a base slug: the base itself first, then `-2`, `-3`, …
 * Kept next to the slug rules so the suffix format is defined in one place.
 */
export function slugCandidate(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`
}
