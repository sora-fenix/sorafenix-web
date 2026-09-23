import { describe, expect, it } from 'vitest'

import {
  MAX_SPACE_SIZE,
  RESULTS_PER_REQUEST_MAX,
  type SearchTarget,
  buildSearchSpace,
  canonicalizeTarget,
  composeQuery,
  fingerprintTarget,
  parseTarget,
  searchTargetSchema,
  strideFor,
  takeWindow,
} from '@/lib/scraping/target'

// A minimal valid target. Fields with defaults are omitted on purpose so the
// defaults themselves are exercised by every test that builds on this.
const baseInput = {
  version: 1,
  keywords: ['pet shop', 'klinik hewan'],
  locations: ['Surabaya', 'Sidoarjo', 'Gresik'],
  pages: [1, 2],
  country: 'id',
  language: 'id',
}

function parsed(overrides: Record<string, unknown> = {}): SearchTarget {
  const result = parseTarget({ ...baseInput, ...overrides })
  if (!result.ok) throw new Error(`fixture does not parse: ${result.error.issues.join('; ')}`)
  return result.value
}

// -----------------------------------------------------------------------------
// parseTarget — the contract with every paying client
// -----------------------------------------------------------------------------

describe('parseTarget', () => {
  it('accepts a minimal target and fills the two defaults', () => {
    const result = parseTarget(baseInput)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.endpoint).toBe('places')
    expect(result.value.resultsPerRequest).toBe(RESULTS_PER_REQUEST_MAX)
  })

  it('trims keyword and location strings on the way in', () => {
    const target = parsed({ keywords: ['  pet shop  '], locations: ['  Surabaya '] })
    expect(target.keywords).toEqual(['pet shop'])
    expect(target.locations).toEqual(['Surabaya'])
  })

  // The bug ADR 0001 point 6 records: `num = 20` cost two Serper credits per
  // search and returned 10 results anyway. A value that doubles the bill must
  // not be representable, so this is a parse failure and not a clamp.
  it('refuses resultsPerRequest above the credit cliff', () => {
    const result = parseTarget({ ...baseInput, resultsPerRequest: 11 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_target')
    expect(result.error.issues.join(' ')).toContain('resultsPerRequest')
  })

  it('refuses a space larger than MAX_SPACE_SIZE', () => {
    const keywords = Array.from({ length: 60 }, (_, i) => `keyword-${i}`)
    const locations = Array.from({ length: 250 }, (_, i) => `location-${i}`)
    // 60 x 250 x 2 = 30_000
    expect(keywords.length * locations.length * 2).toBeGreaterThan(MAX_SPACE_SIZE)

    const result = parseTarget({ ...baseInput, keywords, locations, pages: [1, 2] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.join(' ')).toContain('MAX_SPACE_SIZE')
  })

  // The refine used to count the raw arrays, so `pages: [1, 1]` was charged as
  // two pages and a legal 15 000-cell target was rejected with a message that
  // contradicted the tenant's own arithmetic. It is judged on what it sweeps.
  it('measures the canonical space, not the authored arrays', () => {
    const keywords = Array.from({ length: 60 }, (_, i) => `keyword-${i}`)
    const locations = Array.from({ length: 250 }, (_, i) => `location-${i}`)

    const single = parseTarget({ ...baseInput, keywords, locations, pages: [1] })
    const duplicated = parseTarget({ ...baseInput, keywords, locations, pages: [1, 1] })

    // Same real space — one page, 15 000 cells, under the 20 000 cap.
    expect(single.ok).toBe(true)
    expect(duplicated.ok).toBe(true)
    if (!duplicated.ok) return
    expect(buildSearchSpace(duplicated.value)).toHaveLength(15_000)
  })

  it('measures deduped keywords too', () => {
    // 60 authored keywords that are really 30, x 250 locations x 2 pages
    // = 15 000 canonical, though the raw arithmetic says 30 000.
    const keywords = Array.from({ length: 60 }, (_, i) => `keyword-${Math.floor(i / 2)}`)
    const locations = Array.from({ length: 250 }, (_, i) => `location-${i}`)
    const result = parseTarget({ ...baseInput, keywords, locations, pages: [1, 2] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(buildSearchSpace(result.value)).toHaveLength(15_000)
  })

  it('accepts a space of exactly MAX_SPACE_SIZE', () => {
    const keywords = Array.from({ length: 40 }, (_, i) => `keyword-${i}`)
    const locations = Array.from({ length: 250 }, (_, i) => `location-${i}`)
    expect(keywords.length * locations.length * 2).toBe(MAX_SPACE_SIZE)
    expect(parseTarget({ ...baseInput, keywords, locations, pages: [1, 2] }).ok).toBe(true)
  })

  const rejected: ReadonlyArray<readonly [label: string, patch: Record<string, unknown>]> = [
    ['version 2 is not this parser', { version: 2 }],
    ['version missing', { version: undefined }],
    ['no keywords', { keywords: [] }],
    ['a one-character keyword', { keywords: ['a'] }],
    ['61 keywords', { keywords: Array.from({ length: 61 }, (_, i) => `k-${i}`) }],
    ['no locations', { locations: [] }],
    ['251 locations', { locations: Array.from({ length: 251 }, (_, i) => `l-${i}`) }],
    ['no pages', { pages: [] }],
    ['page 0', { pages: [0] }],
    ['page 11', { pages: [11] }],
    ['a fractional page', { pages: [1.5] }],
    ['eleven pages', { pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1] }],
    ['resultsPerRequest 0', { resultsPerRequest: 0 }],
    ['uppercase country', { country: 'ID' }],
    ['three-letter country', { country: 'idn' }],
    ['country is not defaulted', { country: undefined }],
    ['language is not defaulted', { language: undefined }],
    ['a language with no primary subtag', { language: '-BR' }],
    ['an unknown endpoint', { endpoint: 'news' }],
    ['a 501-character note', { notes: 'x'.repeat(501) }],
  ]

  for (const [label, patch] of rejected) {
    it(`rejects: ${label}`, () => {
      const result = parseTarget({ ...baseInput, ...patch })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('invalid_target')
      expect(result.error.issues.length).toBeGreaterThan(0)
    })
  }

  it('accepts a regional language subtag', () => {
    expect(parseTarget({ ...baseInput, language: 'pt-BR' }).ok).toBe(true)
  })

  // ADR 0001: nothing here is Indonesia-shaped. An FMCG tenant in Vietnam is
  // expressible with no schema change, which is the whole point of the field.
  it('accepts a tenant in another country and language', () => {
    const result = parseTarget({
      version: 1,
      endpoint: 'search',
      keywords: ['cửa hàng tạp hóa'],
      locations: ['Ho Chi Minh City'],
      pages: [1],
      country: 'vn',
      language: 'vi',
    })
    expect(result.ok).toBe(true)
  })

  it('is not an exception path for junk input', () => {
    for (const junk of [null, undefined, 42, 'target', [], {}]) {
      const result = parseTarget(junk)
      expect(result.ok).toBe(false)
    }
  })
})

// -----------------------------------------------------------------------------
// canonicalizeTarget / fingerprintTarget — cursor validity
// -----------------------------------------------------------------------------

describe('canonicalizeTarget', () => {
  it('collapses internal whitespace and sorts keywords and locations', () => {
    const target = parsed({
      keywords: ['toko  kucing', 'pet\tshop'],
      locations: ['Sidoarjo', 'Gresik', 'Surabaya  Timur'],
    })
    const canonical = canonicalizeTarget(target)
    expect(canonical.keywords).toEqual(['pet shop', 'toko kucing'])
    expect(canonical.locations).toEqual(['Gresik', 'Sidoarjo', 'Surabaya Timur'])
  })

  it('sorts and dedupes pages numerically, not as strings', () => {
    const canonical = canonicalizeTarget(parsed({ pages: [10, 2, 1, 2] }))
    expect(canonical.pages).toEqual([1, 2, 10])
  })

  // Keywords and locations are deduped the way pages always were. A duplicate
  // is two byte-identical `q` strings per lap: a second sequential Serper call
  // whose whole result set arrives as merged duplicates.
  it('dedupes keywords and locations, including near-duplicates', () => {
    const canonical = canonicalizeTarget(
      parsed({
        keywords: ['pet shop', 'pet  shop', ' pet shop ', 'klinik hewan'],
        locations: ['Surabaya', 'Surabaya', 'Gresik'],
      }),
    )
    expect(canonical.keywords).toEqual(['klinik hewan', 'pet shop'])
    expect(canonical.locations).toEqual(['Gresik', 'Surabaya'])
  })

  it('normalises to NFC so identical-looking text is one keyword', () => {
    const canonical = canonicalizeTarget(
      parsed({ keywords: ['cửa hàng'.normalize('NFC'), 'cửa hàng'.normalize('NFD')] }),
    )
    expect(canonical.keywords).toEqual(['cửa hàng'.normalize('NFC')])
  })

  it('lowercases the Serper locale codes', () => {
    const canonical = canonicalizeTarget(parsed({ language: 'pt-BR' }))
    expect(canonical.language).toBe('pt-br')
    expect(canonical.country).toBe('id')
  })

  it('is idempotent', () => {
    const once = canonicalizeTarget(parsed({ keywords: ['b  b', 'a a'] }))
    expect(canonicalizeTarget(once)).toEqual(once)
  })

  // The guard that makes fingerprintTarget's object rest actually safe.
  //
  // `canonicalizeTarget` is a hand-written literal, so the rest spread only
  // protects the keys it happens to return. Add an OPTIONAL field to the schema
  // and forget it here and the compiler stays silent — the literal is still
  // assignable to SearchTarget with the key missing — while the field drops out
  // of the fingerprint. A tenant edits it, the cursor is not reset, and the
  // campaign keeps issuing `position` into a space that no longer exists, which
  // is the exact failure ADR §2 says the fingerprint prevents.
  //
  // If this fails after you added a field: add it to canonicalizeTarget. Then
  // decide whether it can change the search space. If it cannot, and only then,
  // also name it on the rest-spread line in fingerprintTarget.
  it('covers the whole schema, so no field can slip out of the fingerprint', () => {
    expect(Object.keys(canonicalizeTarget(parsed({ notes: 'catatan' })))).toEqual(
      Object.keys(searchTargetSchema.shape),
    )
  })
})

describe('fingerprintTarget', () => {
  it('is a 64-character hex sha256', () => {
    expect(fingerprintTarget(parsed())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across reordering, spacing and locale case', () => {
    const a = parsed({
      keywords: ['pet shop', 'klinik hewan'],
      locations: ['Surabaya', 'Sidoarjo', 'Gresik'],
      pages: [1, 2],
    })
    const b = parsed({
      keywords: ['klinik  hewan', 'pet shop '],
      locations: ['Gresik', 'Surabaya', 'Sidoarjo'],
      pages: [2, 1, 2],
    })
    expect(fingerprintTarget(b)).toBe(fingerprintTarget(a))
  })

  // The risk ADR 0001 lists first: a target edited while a cursor keeps indexing
  // the old space. The fingerprint moving is what forces the reset.
  const changes: ReadonlyArray<readonly [label: string, patch: Record<string, unknown>]> = [
    ['an added keyword', { keywords: ['pet shop', 'klinik hewan', 'grooming hewan'] }],
    ['a removed location', { locations: ['Surabaya', 'Sidoarjo'] }],
    ['an added page', { pages: [1, 2, 3] }],
    ['a different country', { country: 'my' }],
    ['a different language', { language: 'en' }],
    ['a different endpoint', { endpoint: 'search' }],
    ['a smaller resultsPerRequest', { resultsPerRequest: 5 }],
  ]

  for (const [label, patch] of changes) {
    it(`changes on ${label}`, () => {
      expect(fingerprintTarget(parsed(patch))).not.toBe(fingerprintTarget(parsed()))
    })
  }

  // The inverse of the first draft of this case, and deliberately kept rather
  // than deleted. ADR 0001 §2 step 3, as amended, hashes the canonical target
  // MINUS its notes: the fingerprint may depend only on what can change the
  // space, and `notes` is never sent to Serper. Hashing it meant fixing a typo
  // in a human comment reset `position` and `lap` and restarted a 90-day sweep.
  it('does not change when only the note changes', () => {
    const withNote = parsed({ notes: 'catatan untuk tim sales' })
    const withOther = parsed({ notes: 'catatan lain sama sekali' })
    expect(fingerprintTarget(withNote)).toBe(fingerprintTarget(parsed()))
    expect(fingerprintTarget(withOther)).toBe(fingerprintTarget(withNote))
  })

  it('still carries the note on the parsed and canonical target', () => {
    // Excluded from the hash, not dropped from the record: a human wrote it.
    const target = parsed({ notes: 'catatan' })
    expect(target.notes).toBe('catatan')
    expect(canonicalizeTarget(target).notes).toBe('catatan')
  })

  // Unicode normalisation, measured: the two spellings of "cửa hàng" render
  // identically and differ in bytes. Without NFC an ops person re-pasting the
  // same keyword from a different editor restarts the tenant's lap.
  it('is stable across NFC and NFD spellings of the same word', () => {
    const nfc = 'cửa hàng'.normalize('NFC')
    const nfd = 'cửa hàng'.normalize('NFD')
    expect(nfd).not.toBe(nfc) // the fixture is only meaningful if they differ
    expect(fingerprintTarget(parsed({ keywords: [nfd] }))).toBe(
      fingerprintTarget(parsed({ keywords: [nfc] })),
    )
  })

  it('is stable across a duplicated keyword, location or page', () => {
    const deduped = parsed({
      keywords: ['pet shop', 'pet shop', 'klinik  hewan', 'klinik hewan'],
      locations: ['Surabaya', 'Sidoarjo', 'Gresik', 'Surabaya'],
      pages: [1, 2, 1],
    })
    expect(fingerprintTarget(deduped)).toBe(fingerprintTarget(parsed()))
  })
})

// -----------------------------------------------------------------------------
// strideFor — the permutation's only moving part
// -----------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  let x = a
  let y = b
  while (y !== 0) {
    const r = x % y
    x = y
    y = r
  }
  return x
}

function isPrime(n: number): boolean {
  if (n < 2) return false
  for (let d = 2; d * d <= n; d += 1) if (n % d === 0) return false
  return true
}

describe('strideFor', () => {
  // Worked by hand from the definition: the smallest prime > sqrt(n) coprime
  // with n. The degenerate rows are the ones worth spelling out.
  const cases: ReadonlyArray<readonly [blockSize: number, stride: number]> = [
    [1, 2], // sqrt 1, prime > 1 is 2, and everything is coprime with 1
    [2, 3], // sqrt ~1.41, 2 is rejected: it divides 2
    [3, 2], // sqrt ~1.73, 2 is prime and coprime with 3
    [4, 3], // sqrt 2 exactly, so the candidate must be strictly greater
    [5, 3],
    [6, 5], // 3 divides 6
    [8, 3],
    [9, 5], // sqrt 3 exactly; 4 is not prime, 5 is
    [10, 7], // 4 not prime, 5 divides 10, 6 not prime
    [25, 7],
    [300, 19], // 12 keywords x 25 locations — today's real block
  ]

  for (const [blockSize, stride] of cases) {
    it(`blockSize ${blockSize} -> stride ${stride}`, () => {
      expect(strideFor(blockSize)).toBe(stride)
    })
  }

  it('is total, prime, above sqrt and coprime for every block up to 500', () => {
    for (let n = 1; n <= 500; n += 1) {
      const stride = strideFor(n)
      expect(isPrime(stride)).toBe(true)
      expect(stride).toBeGreaterThan(Math.sqrt(n))
      expect(gcd(stride, n)).toBe(1)
    }
  })

  // Both of these hang rather than throw without the guard, which is the worst
  // failure mode available: nothing is coprime with 0, and for NaN `isPrime`
  // returns true (no comparison against NaN is ever true, so nothing rejects it)
  // and then the gcd loop spins forever on `NaN !== 0`. If this test times out,
  // the guard is gone.
  it('does not hang on a degenerate block size', () => {
    expect(strideFor(0)).toBe(1)
    expect(strideFor(-3)).toBe(1)
  })

  it('does not hang on a non-integer block size', () => {
    expect(strideFor(Number.NaN)).toBe(1)
    expect(strideFor(12.5)).toBe(1)
    expect(strideFor(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// buildSearchSpace — what actually gets searched
// -----------------------------------------------------------------------------

describe('buildSearchSpace', () => {
  it('has exactly keywords x locations x pages items, indexed 0..n-1', () => {
    const space = buildSearchSpace(parsed())
    expect(space).toHaveLength(2 * 3 * 2)
    expect(space.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  // The risk ADR 0001 names: "the space permutation skips or repeats
  // combinations". A lap must be a bijection onto the combinations, or a tenant
  // pays twice for one cell and never sees another.
  it('covers every combination exactly once', () => {
    const space = buildSearchSpace(parsed())
    const seen = space.map((item) => `${item.keyword}|${item.location}|${item.page}`)
    expect(new Set(seen).size).toBe(space.length)
  })

  it('covers every combination exactly once for an awkward block size', () => {
    // 6 x 4 = 24 per block, three pages. 24 is the case where the first prime
    // above sqrt divides the block.
    const target = parsed({
      keywords: Array.from({ length: 6 }, (_, i) => `keyword-${i}`),
      locations: Array.from({ length: 4 }, (_, i) => `location-${i}`),
      pages: [1, 2, 3],
    })
    const space = buildSearchSpace(target)
    expect(space).toHaveLength(72)
    const seen = space.map((item) => `${item.keyword}|${item.location}|${item.page}`)
    expect(new Set(seen).size).toBe(72)
  })

  // ADR 0001 §2 step 2: page 1 is the highest yield per credit, so a tenant's
  // first days buy the most.
  it('is page-major ascending', () => {
    const space = buildSearchSpace(parsed({ pages: [2, 1] }))
    expect(space.slice(0, 6).every((item) => item.page === 1)).toBe(true)
    expect(space.slice(6).every((item) => item.page === 2)).toBe(true)
  })

  // ADR 0001 §2 step 3: this is the property `i % SLICES` gave by accident and
  // that a plain contiguous window would lose. A day must be a mix.
  it('mixes keywords and locations inside a page block', () => {
    const target = parsed({
      keywords: Array.from({ length: 12 }, (_, i) => `keyword-${String(i).padStart(2, '0')}`),
      locations: Array.from({ length: 25 }, (_, i) => `location-${String(i).padStart(2, '0')}`),
      pages: [1],
    })
    const firstDay = buildSearchSpace(target).slice(0, 25)
    expect(new Set(firstDay.map((item) => item.keyword)).size).toBeGreaterThan(1)
    expect(new Set(firstDay.map((item) => item.location)).size).toBeGreaterThan(1)
  })

  it('is deterministic and independent of the authored order', () => {
    const a = buildSearchSpace(parsed())
    const b = buildSearchSpace(
      parsed({
        keywords: ['klinik hewan ', 'pet  shop'],
        locations: ['Gresik', 'Sidoarjo', 'Surabaya'],
        pages: [2, 1],
      }),
    )
    expect(b).toEqual(a)
  })

  it('never issues the same query twice in a lap, even from a duplicated target', () => {
    // The point of the dedupe: two identical keywords used to mean two
    // byte-identical Serper calls, charged separately.
    const space = buildSearchSpace(
      parsed({
        keywords: ['pet shop', 'pet  shop'],
        locations: ['Surabaya', ' Surabaya '],
        pages: [1, 1],
      }),
    )
    expect(space).toHaveLength(1)
    const queries = space.map((item) => composeQuery(item.keyword, item.location))
    expect(new Set(queries).size).toBe(queries.length)
  })

  it('handles the smallest possible space', () => {
    const space = buildSearchSpace(
      parsed({ keywords: ['pet shop'], locations: ['Surabaya'], pages: [1] }),
    )
    expect(space).toEqual([{ index: 0, keyword: 'pet shop', location: 'Surabaya', page: 1 }])
  })
})

// -----------------------------------------------------------------------------
// takeWindow — the cursor
// -----------------------------------------------------------------------------

describe('takeWindow', () => {
  const space = buildSearchSpace(parsed()) // 12 items

  it('issues from the position and advances it', () => {
    const window = takeWindow(space, { position: 0, lap: 0 }, 5)
    expect(window.items.map((item) => item.index)).toEqual([0, 1, 2, 3, 4])
    expect(window.position).toBe(5)
    expect(window.lap).toBe(0)
  })

  it('resumes where the previous window stopped', () => {
    const first = takeWindow(space, { position: 0, lap: 0 }, 5)
    const second = takeWindow(space, first, 4)
    expect(second.items.map((item) => item.index)).toEqual([5, 6, 7, 8])
    expect(second.position).toBe(9)
  })

  it('wraps modulo the space size and counts the lap', () => {
    const window = takeWindow(space, { position: 10, lap: 0 }, 4)
    expect(window.items.map((item) => item.index)).toEqual([10, 11, 0, 1])
    expect(window.position).toBe(2)
    expect(window.lap).toBe(1)
  })

  it('lands exactly on zero when a window completes a lap', () => {
    const window = takeWindow(space, { position: 0, lap: 3 }, 12)
    expect(window.items).toHaveLength(12)
    expect(window.position).toBe(0)
    expect(window.lap).toBe(4)
  })

  it('counts every wrap when the window is longer than the space', () => {
    const window = takeWindow(space, { position: 0, lap: 0 }, 25)
    expect(window.items).toHaveLength(25)
    expect(window.lap).toBe(2)
    expect(window.position).toBe(1)
  })

  it('walks the whole space in order across consecutive windows', () => {
    let cursor = { position: 0, lap: 0 }
    const collected: number[] = []
    for (let day = 0; day < 4; day += 1) {
      const window = takeWindow(space, cursor, 3)
      collected.push(...window.items.map((item) => item.index))
      cursor = { position: window.position, lap: window.lap }
    }
    expect(collected).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(cursor).toEqual({ position: 0, lap: 1 })
  })

  // A campaign that contributes nothing is an empty list, never an exception.
  it('returns an empty window and leaves the cursor alone for a zero count', () => {
    const window = takeWindow(space, { position: 7, lap: 2 }, 0)
    expect(window).toEqual({ items: [], position: 7, lap: 2 })
  })

  // Same defect class as strideFor's Number.isInteger arm: a function documented
  // total that was not. Without the Number.isFinite guard this does not fail —
  // it runs until the push throws `RangeError: Invalid array length`. If this
  // case ever times out instead of failing, the guard is gone.
  it('returns an empty window for a non-finite count', () => {
    for (const count of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(takeWindow(space, { position: 7, lap: 2 }, count)).toEqual({
        items: [],
        position: 7,
        lap: 2,
      })
    }
  })

  it('returns an empty window for an empty space without dividing by zero', () => {
    expect(takeWindow([], { position: 3, lap: 1 }, 10)).toEqual({
      items: [],
      position: 3,
      lap: 1,
    })
  })

  it('tolerates a position left over from a larger space', () => {
    const window = takeWindow(space, { position: 40, lap: 0 }, 2)
    expect(window.items.map((item) => item.index)).toEqual([4, 5])
  })

  it('tolerates a negative position', () => {
    const window = takeWindow(space, { position: -1, lap: 0 }, 2)
    expect(window.items.map((item) => item.index)).toEqual([11, 0])
    expect(window.lap).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// composeQuery
// -----------------------------------------------------------------------------

describe('composeQuery', () => {
  // Verified against n8n/workflows/sora-lead-hunter.json, node `Serper Places`:
  //   q: $json.keyword + ' ' + $json.lokasi
  // A query issued from here and one n8n composed for itself must be the same
  // string, or the first plan would silently re-search ground already swept.
  it('joins keyword and location with a single space, as the n8n node does', () => {
    expect(composeQuery('pet shop', 'Surabaya')).toBe('pet shop Surabaya')
    expect(composeQuery('toko pakan hewan', 'Rungkut Surabaya')).toBe(
      'toko pakan hewan Rungkut Surabaya',
    )
  })

  it('composes cleanly from a canonical space item', () => {
    const [item] = buildSearchSpace(
      parsed({ keywords: ['pet  shop'], locations: [' Surabaya Timur '], pages: [1] }),
    )
    expect(item).toBeDefined()
    if (item === undefined) return
    expect(composeQuery(item.keyword, item.location)).toBe('pet shop Surabaya Timur')
  })
})
