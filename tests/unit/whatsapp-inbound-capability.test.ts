import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * What the inbound WhatsApp path is INCAPABLE of.
 *
 * `tests/integration/whatsapp.test.ts` proves that a "STOP" reply writes no
 * suppression and moves no lead today. This file proves it cannot start doing so
 * tomorrow, by reading the source and failing on the import or the write that would
 * make it possible.
 *
 * Two failures are being prevented, and neither is hypothetical:
 *
 *  1. A path from inbound text to `suppressions` is a path from one forged webhook
 *     to a client's entire contact list going silent. Whoever can reach the endpoint
 *     chooses the text.
 *  2. A path from inbound text to `leads.status` is a way to rewrite a pipeline from
 *     outside, bypassing `crm/status.ts` and the activity row it writes (rule 10).
 *
 * Plus rule 5: no inbound event may produce an outbound message or call a model.
 * Auto-reply is not a feature we are one refactor away from — it is a thing a human
 * approves.
 *
 * WHAT A STATIC GUARD HAS TO GET RIGHT, because the first version of this file got
 * all three wrong and review caught them:
 *
 *  - **Dynamic import.** `await import('@/lib/outreach/send')` is a complete bypass
 *    of an allowlist that only reads `from '…'`. `import(` and `require(` are matched
 *    below, and then banned outright, so a specifier built from a variable cannot
 *    hide either.
 *  - **Naming.** A helper called `suppressContact` in a module called `suppress` does
 *    not contain the word "suppressions". The pattern is the stem.
 *  - **Raw SQL and deletes.** `tx.execute(sql\`update leads …\`)` needs no new import
 *    at all — `db` and `sql` are already here — and `delete(schema.contacts)` is a
 *    write the insert/update pattern never looked at. Both are covered, and
 *    `execute(` is banned so no raw statement can run from these files.
 *
 * The comment stripper is string-aware for the same reason: a naive
 * `/\/\*[\s\S]*?\*\//` blanks everything between a `'/*'` inside a string literal and
 * the next `*\/`, which is real source the scan would then never see.
 *
 * This test reads files instead of calling functions, which is unusual for the unit
 * suite. It stays here rather than in the integration suite because it needs no
 * database, no network and no environment, and because the gate everybody runs is
 * `pnpm test`. A behavioural test cannot prove an absence; this can.
 */

const INBOUND = 'src/lib/outreach/whatsapp-inbound.ts'
const ROUTE = 'src/app/api/webhooks/whatsapp/route.ts'
const TRANSPORT = 'src/lib/outreach/whatsapp.ts'
const ACCOUNT = 'src/lib/outreach/whatsapp-account.ts'

/** Every file the inbound path is built from. */
const INBOUND_PATH_FILES = [INBOUND, ROUTE, TRANSPORT, ACCOUNT] as const

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
}

/**
 * The file with its comments removed and its strings left alone.
 *
 * Comments have to go: these files discuss `suppressions` and `leads.status` at
 * length — that is the point of them — so a scan over raw source would match the
 * explanation of the rule and never a violation of it.
 *
 * Strings have to stay: they hold the import specifiers the allowlist reads.
 *
 * Hand-written scanner rather than a regex, because the two requirements interact: a
 * regex cannot tell a `/*` that opens a comment from one sitting inside a string. A
 * comment start inside a template's `${…}` is treated as part of the template and
 * survives, which can only ever cause a false failure — the safe direction for a
 * guard to be wrong in.
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0

  while (i < source.length) {
    const two = source.slice(i, i + 2)

    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }

    if (two === '/*') {
      i += 2
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1
      i += 2
      continue
    }

    const char = source[i]
    if (char === undefined) break

    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      i += 1
      while (i < source.length) {
        const inner = source[i]
        if (inner === undefined) break
        out += inner
        i += 1
        if (inner === '\\') {
          out += source[i] ?? ''
          i += 1
          continue
        }
        if (inner === quote) break
      }
      continue
    }

    out += char
    i += 1
  }

  return out
}

function code(relative: string): string {
  return stripComments(read(relative))
}

/**
 * Module specifiers this file references, however it references them.
 *
 * Covers `from 'x'`, `from "x"`, `import 'x'`, `import('x')` and `require('x')`.
 */
function imports(relative: string): string[] {
  const found: string[] = []
  for (const match of code(relative).matchAll(
    /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g,
  )) {
    const specifier = match[1]
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

// -----------------------------------------------------------------------------
// The scanner itself, since everything below trusts it
// -----------------------------------------------------------------------------

describe('stripComments', () => {
  it('removes both kinds of comment', () => {
    expect(stripComments('a // gone\nb')).toBe('a \nb')
    expect(stripComments('a /* gone */ b')).toBe('a  b')
  })

  // The bug this scanner exists for: a naive regex blanks from the quoted `/*` to the
  // next `*/`, taking real source — and any violation in it — with it.
  it('does not treat a comment marker inside a string as a comment', () => {
    const source = "const marker = '/*'\nawait tx.delete(schema.suppressions)\nconst end = '*/'"
    expect(stripComments(source)).toContain('delete(schema.suppressions)')
  })

  it('keeps import specifiers, which the allowlist reads', () => {
    expect(stripComments("import { x } from '@/lib/y' // note")).toBe(
      "import { x } from '@/lib/y' ",
    )
  })

  it('is not confused by an escaped quote', () => {
    expect(stripComments("const a = 'it\\'s' /* gone */")).toBe("const a = 'it\\'s' ")
  })
})

// -----------------------------------------------------------------------------

describe('the inbound WhatsApp path', () => {
  it('never names suppression, under any spelling', () => {
    for (const file of INBOUND_PATH_FILES) {
      // The stem, not the table name: `suppressContact` from a module called
      // `suppress` is the same capability under a different word.
      expect(code(file), file).not.toMatch(/suppress/i)
    }
  })

  it('never writes a lead, and never reaches lib/crm/status.ts', () => {
    for (const file of INBOUND_PATH_FILES) {
      const source = code(file)
      expect(source, file).not.toContain('transitionLeadStatus')
      expect(source, file).not.toContain('crm/status')
      // A select from `leads` is how a reply finds its lead; a write is not.
      expect(source, file).not.toMatch(/(?:update|insert|delete)\(schema\.leads\)/)
      expect(source, file).not.toMatch(/status:\s*'(new|contacted|qualified|won|lost)'/)
    }
  })

  it('never calls a model (rule 5: no auto-reply)', () => {
    for (const file of INBOUND_PATH_FILES) {
      const source = code(file)
      expect(source, file).not.toContain('runAgent')
      expect(source, file).not.toContain('lib/ai/')
    }
  })

  /**
   * No raw statements, and no escape hatch out of the query builder. `db` and `sql`
   * are already imported here, so `tx.execute(sql`update leads …`)` would need no new
   * import and the write patterns above would never see it.
   */
  it('runs no raw SQL', () => {
    for (const file of INBOUND_PATH_FILES) {
      const source = code(file)
      expect(source, file).not.toMatch(/\bexecute\s*\(/)
      expect(source, file).not.toMatch(/\bunsafe\s*\(/)
      expect(source, file).not.toContain('$client')
    }
  })

  /**
   * Static imports only, so the allowlist below is the complete list of what these
   * files can reach. A dynamic import is how an auto-reply would arrive in one line
   * without touching the import block.
   */
  it('imports nothing dynamically', () => {
    for (const file of INBOUND_PATH_FILES) {
      const source = code(file)
      expect(source, file).not.toMatch(/\bimport\s*\(/)
      expect(source, file).not.toMatch(/\brequire\s*\(/)
    }
  })

  it('never creates an outbound message', () => {
    const source = code(INBOUND)
    // The one insert into `messages` is the inbound row. `direction: 'out'` is what
    // an auto-reply would need, and a filter on direction reads `eq(…, 'out')`.
    expect(source).not.toContain("direction: 'out'")
    expect(source.match(/insert\(schema\.messages\)/g)).toHaveLength(1)
    expect(source).toContain("direction: 'in'")
  })

  it('writes only to `messages` and `webhook_events`', () => {
    const source = code(INBOUND)
    const written = [...source.matchAll(/(?:insert|update|delete)\(schema\.(\w+)\)/g)].map(
      (match) => match[1],
    )
    expect(new Set(written)).toEqual(new Set(['messages', 'webhookEvents']))
  })

  /**
   * The allowlist is the real pin. A new import here is how every one of the writes
   * above would arrive, so adding one has to be a deliberate act that fails this
   * test first and makes someone re-read the capability note at the top of
   * `whatsapp-inbound.ts`.
   */
  it('imports nothing that could widen what it may write', () => {
    expect(imports(INBOUND)).toEqual([
      'server-only',
      'drizzle-orm',
      'zod',
      '@/lib/db/drizzle',
      '@/lib/db/schema',
      '@/lib/leads/normalize',
      './whatsapp',
      './whatsapp-account',
    ])

    expect(imports(ROUTE)).toEqual([
      'next/server',
      'zod',
      '@/lib/outreach/whatsapp-inbound',
      '@/lib/webhooks/signature',
    ])
  })

  it('does not reference the send path, so an inbound event cannot send', () => {
    for (const file of [INBOUND, ROUTE]) {
      const source = code(file)
      expect(imports(file), file).not.toContain('@/lib/outreach/send')
      expect(source, file).not.toContain("'./send'")
      expect(source, file).not.toContain('sendMessage')
    }
  })
})
