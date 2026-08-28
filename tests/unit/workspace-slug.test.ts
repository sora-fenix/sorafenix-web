import { describe, expect, it } from 'vitest'

import { slugCandidate, slugifyWorkspaceName } from '@/lib/workspace/slug'

/**
 * The slug becomes the workspace's permanent address. A bad one is not a cosmetic
 * problem — it is a URL that either does not route or collides with one that does.
 */

describe('slugifyWorkspaceName', () => {
  const cases: ReadonlyArray<readonly [label: string, input: string, expected: string]> = [
    // --- the ordinary path ---
    ['plain name', 'Maju Bersama', 'maju-bersama'],
    ['the seed workspace', 'PT Maju Bersama Digital', 'maju-bersama-digital'],
    ['CV prefix', 'CV Sinar Jaya', 'sinar-jaya'],
    ['UD prefix', 'UD Berkah Abadi', 'berkah-abadi'],
    ['Tbk suffix', 'PT Astra International Tbk', 'astra-international'],
    ['already lowercase', 'toko bahagia', 'toko-bahagia'],

    // --- separators and punctuation ---
    ['ampersand', 'Bahagia & Sejahtera', 'bahagia-sejahtera'],
    // Inherited from normalizeCompanyName: LEGAL_FORMS matches "pt" followed by
    // whitespace, so the dotted spelling is not recognised as a legal form and
    // survives as part of the name. Pinned rather than fixed — widening that
    // regex would change dedupe's fuzzy matching, which is not this slice's call.
    ['dotted legal form is not stripped', 'P.T. Maju', 'p-t-maju'],
    ['existing hyphens', 'Maju-Bersama', 'maju-bersama'],
    ['runs of spaces', 'Maju    Bersama', 'maju-bersama'],
    ['leading and trailing junk', '  ...Maju Bersama!!!  ', 'maju-bersama'],
    ['digits survive', 'Toko 24 Jam', 'toko-24-jam'],

    // --- non-ASCII ---
    ['accents folded', 'Café Nusantara', 'cafe-nusantara'],

    // --- degenerate input falls back rather than throwing ---
    ['punctuation only', '!!!', 'workspace'],
    ['empty string', '', 'workspace'],
    ['whitespace only', '   ', 'workspace'],
    // "PT" alone is a legal form with nothing behind it. LEGAL_FORMS only matches
    // when followed by whitespace, so the bare token survives as the name.
    ['legal form alone', 'PT', 'pt'],
  ]

  for (const [label, input, expected] of cases) {
    it(`${label}: ${JSON.stringify(input)} → ${expected}`, () => {
      expect(slugifyWorkspaceName(input)).toBe(expected)
    })
  }

  it('never returns an empty string', () => {
    for (const [, input] of cases) {
      expect(slugifyWorkspaceName(input).length).toBeGreaterThan(0)
    }
  })

  it('clamps a long name without leaving a trailing separator', () => {
    const slug = slugifyWorkspaceName('Perusahaan Dagang Sejahtera Makmur Abadi Nusantara Jaya')

    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug.startsWith('perusahaan-dagang-sejahtera')).toBe(true)
  })
})

describe('slugifyWorkspaceName — reserved words', () => {
  // These would shadow a literal route under /app. Next.js resolves a static
  // segment before [workspace], so a workspace slugged `new` becomes unreachable
  // the day someone adds /app/new.
  const reserved = ['api', 'app', 'auth', 'login', 'logout', 'new', 'settings', 'admin']

  for (const word of reserved) {
    it(`refuses to hand out "${word}"`, () => {
      expect(slugifyWorkspaceName(word)).toBe(`${word}-1`)
    })
  }

  it('leaves a reserved word alone when it is part of a longer name', () => {
    expect(slugifyWorkspaceName('New Horizon')).toBe('new-horizon')
  })
})

describe('slugCandidate', () => {
  it('offers the bare slug first', () => {
    expect(slugCandidate('maju-bersama', 0)).toBe('maju-bersama')
  })

  it('counts from 2, because the first taken slug is number 1', () => {
    expect(slugCandidate('maju-bersama', 1)).toBe('maju-bersama-2')
    expect(slugCandidate('maju-bersama', 2)).toBe('maju-bersama-3')
  })
})
