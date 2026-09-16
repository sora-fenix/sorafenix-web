/**
 * Page arithmetic for the list screens.
 *
 * Pure and import-free: the page number arrives from the URL, which means it
 * arrives from anyone, and every way of getting it wrong — `?page=abc`,
 * `?page=-1`, `?page=1e9`, `?page=1&page=2` — has to be decided here rather than
 * reaching an OFFSET. A negative offset is a database error; a gigantic one is a
 * table scan that returns nothing and looks like an empty workspace.
 *
 * `src/lib/db/queries/records.ts` counts first and then clamps, so a page past
 * the end shows the last page instead of an empty table with no way back.
 */

/** Rows per page on every list screen. Was the old fixed `PAGE_SIZE` limit. */
export const DEFAULT_PAGE_SIZE = 100

/** Nobody may ask for more than this in one request, whatever the URL says. */
export const MAX_PAGE_SIZE = 500

export type PageRequest = {
  readonly page: number
  readonly pageSize: number
  readonly offset: number
}

export type Page<T> = {
  readonly rows: readonly T[]
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly totalPages: number
  readonly hasPrevious: boolean
  readonly hasNext: boolean
  /** 1-based index of the first row shown; 0 when there are none. */
  readonly from: number
  /** 1-based index of the last row shown; 0 when there are none. */
  readonly to: number
}

/**
 * What Next hands a page component for one query parameter.
 *
 * `?page=1&page=2` really does arrive as an array, and reading `[0]` of it
 * silently honours the first value. The last one wins here, which is what a user
 * editing the URL would expect.
 */
export type SearchParamValue = string | string[] | undefined

export function parsePageParam(value: SearchParamValue): number {
  const raw = Array.isArray(value) ? value[value.length - 1] : value
  if (raw === undefined) return 1

  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed)) return 1
  // Truncated, not rounded: `?page=1.9` is page 1, never page 2.
  const page = Math.trunc(parsed)
  return page < 1 ? 1 : page
}

export function pageRequest(value: SearchParamValue, pageSize = DEFAULT_PAGE_SIZE): PageRequest {
  const size = clampPageSize(pageSize)
  const page = parsePageParam(value)
  return { page, pageSize: size, offset: (page - 1) * size }
}

export function clampPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE
  const size = Math.trunc(pageSize)
  if (size < 1) return 1
  return size > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : size
}

export function totalPagesFor(total: number, pageSize: number): number {
  if (total <= 0) return 1
  return Math.ceil(total / clampPageSize(pageSize))
}

/**
 * The request to actually run, once the total is known.
 *
 * Clamping needs the count, and the count needs a query, which is why this is a
 * second step rather than part of `pageRequest`. Asking for page 900 of 13 gives
 * page 13 — the rows a person can act on — instead of a blank screen.
 */
export function clampToTotal(request: PageRequest, total: number): PageRequest {
  const totalPages = totalPagesFor(total, request.pageSize)
  const page = request.page > totalPages ? totalPages : request.page
  return { page, pageSize: request.pageSize, offset: (page - 1) * request.pageSize }
}

export function buildPage<T>(
  rows: readonly T[],
  request: PageRequest,
  total: number,
): Page<T> {
  const totalPages = totalPagesFor(total, request.pageSize)
  const page = request.page > totalPages ? totalPages : request.page
  const from = rows.length === 0 ? 0 : (page - 1) * request.pageSize + 1
  const to = rows.length === 0 ? 0 : from + rows.length - 1

  return {
    rows,
    page,
    pageSize: request.pageSize,
    total,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    from,
    to,
  }
}

/** An empty page, for a screen with nothing to show yet. */
export function emptyPage<T>(pageSize = DEFAULT_PAGE_SIZE): Page<T> {
  return buildPage<T>([], { page: 1, pageSize: clampPageSize(pageSize), offset: 0 }, 0)
}

/**
 * `/app/acme/leads?page=3`, with page 1 written without the parameter so the
 * first page has exactly one URL.
 */
export function pageHref(basePath: string, page: number): string {
  return page <= 1 ? basePath : `${basePath}?page=${String(page)}`
}
