import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPage,
  clampPageSize,
  clampToTotal,
  emptyPage,
  pageHref,
  pageRequest,
  parsePageParam,
  totalPagesFor,
} from '@/lib/pagination'

/**
 * The page number comes out of the URL, so it comes from anyone. Everything below
 * is a way of getting it wrong that would otherwise reach an SQL OFFSET: a
 * negative one is an error, and a huge one is a scan that returns nothing and
 * reads on screen as an empty workspace.
 */

describe('parsing the page parameter', () => {
  it('defaults to page 1 when absent', () => {
    expect(parsePageParam(undefined)).toBe(1)
  })

  it.each([
    ['abc', 1],
    ['', 1],
    ['   ', 1],
    ['0', 1],
    ['-4', 1],
    ['NaN', 1],
    ['Infinity', 1],
    ['3', 3],
    [' 7 ', 7],
  ])('reads %o as page %i', (raw, expected) => {
    expect(parsePageParam(raw)).toBe(expected)
  })

  it('truncates rather than rounds, so ?page=1.9 is page 1', () => {
    expect(parsePageParam('1.9')).toBe(1)
    expect(parsePageParam('2.0')).toBe(2)
  })

  it('takes the last value when the parameter is repeated', () => {
    // ?page=1&page=2 really does arrive as an array.
    expect(parsePageParam(['1', '2'])).toBe(2)
    expect(parsePageParam([])).toBe(1)
  })
})

describe('the page size', () => {
  it('is capped, whatever is asked for', () => {
    expect(clampPageSize(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE)
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('is never zero or negative — that would divide by zero downstream', () => {
    expect(clampPageSize(0)).toBe(1)
    expect(clampPageSize(-10)).toBe(1)
  })
})

describe('the offset', () => {
  it('is zero on page 1 and never negative', () => {
    expect(pageRequest(undefined, 100).offset).toBe(0)
    expect(pageRequest('-5', 100).offset).toBe(0)
  })

  it('steps by the page size', () => {
    expect(pageRequest('3', 100).offset).toBe(200)
    expect(pageRequest('2', 25).offset).toBe(25)
  })
})

describe('clamping to the total', () => {
  it('pulls a page past the end back to the last real page', () => {
    // 1208 leads at 100 a page is 13 pages. Asking for 900 shows 13, not nothing.
    const clamped = clampToTotal(pageRequest('900', 100), 1208)
    expect(clamped.page).toBe(13)
    expect(clamped.offset).toBe(1200)
  })

  it('leaves a page inside the range alone', () => {
    expect(clampToTotal(pageRequest('5', 100), 1208).page).toBe(5)
  })

  it('keeps page 1 for an empty workspace', () => {
    const clamped = clampToTotal(pageRequest('4', 100), 0)
    expect(clamped.page).toBe(1)
    expect(clamped.offset).toBe(0)
  })
})

describe('total pages', () => {
  it.each([
    [0, 100, 1],
    [1, 100, 1],
    [100, 100, 1],
    [101, 100, 2],
    [1208, 100, 13],
  ])('%i rows at %i a page is %i page(s)', (total, size, expected) => {
    expect(totalPagesFor(total, size)).toBe(expected)
  })
})

describe('the built page', () => {
  const rows = Array.from({ length: 100 }, (_, i) => i)

  it('reports the real range, which is the whole point', () => {
    // The bug this replaces: the screen fetched 100 of 1208 and captioned itself
    // "100 prospek", a truncation no reader could detect.
    const page = buildPage(rows, clampToTotal(pageRequest('2', 100), 1208), 1208)
    expect(page.from).toBe(101)
    expect(page.to).toBe(200)
    expect(page.total).toBe(1208)
    expect(page.totalPages).toBe(13)
  })

  it('knows where it is in the range', () => {
    const first = buildPage(rows, clampToTotal(pageRequest('1', 100), 1208), 1208)
    expect(first.hasPrevious).toBe(false)
    expect(first.hasNext).toBe(true)

    const last = buildPage(rows.slice(0, 8), clampToTotal(pageRequest('13', 100), 1208), 1208)
    expect(last.hasPrevious).toBe(true)
    expect(last.hasNext).toBe(false)
    expect(last.from).toBe(1201)
    expect(last.to).toBe(1208)
  })

  it('reports an empty range rather than 1–0', () => {
    const page = buildPage([], { page: 1, pageSize: 100, offset: 0 }, 0)
    expect(page.from).toBe(0)
    expect(page.to).toBe(0)
    expect(page.hasPrevious).toBe(false)
    expect(page.hasNext).toBe(false)
  })

  it('has a ready-made empty value', () => {
    expect(emptyPage().total).toBe(0)
    expect(emptyPage().rows).toEqual([])
  })
})

describe('page links', () => {
  it('writes page 1 without the parameter, so it has one URL', () => {
    expect(pageHref('/app/acme/leads', 1)).toBe('/app/acme/leads')
    expect(pageHref('/app/acme/leads', 0)).toBe('/app/acme/leads')
  })

  it('appends the page otherwise', () => {
    expect(pageHref('/app/acme/leads', 4)).toBe('/app/acme/leads?page=4')
  })
})
