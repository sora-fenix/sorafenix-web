import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openDatabase } from './helpers'

/**
 * Runs the real seed script twice and checks what actually landed in the
 * database — both that the demo workspace is populated, and that a second run
 * is a no-op rather than a duplicate.
 */

const execFileAsync = promisify(execFile)

const WORKSPACE_SLUG = 'maju-bersama'

const EXPECTED_COUNTS: Record<string, number> = {
  memberships: 3,
  products: 1,
  knowledge_docs: 3,
  integrations: 2,
  campaigns: 3,
  companies: 60,
  contacts: 60,
  leads: 60,
  activities: 150,
  messages: 90,
  sequence_runs: 25,
  suppressions: 5,
  ai_runs: 12,
  webhook_events: 3,
}

const ALL_LEAD_STATUSES = [
  'new',
  'qualified',
  'contacted',
  'replied',
  'interested',
  'meeting',
  'proposal',
  'negotiation',
  'won',
  'lost',
  'do_not_contact',
]

let sql: postgres.Sql
let workspaceId: string

async function runSeed(): Promise<void> {
  // Spawned rather than imported: the script's top-level main() is not awaited,
  // so an import would return before the seed had finished writing.
  await execFileAsync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/seed.ts'], {
    cwd: process.cwd(),
    timeout: 120_000,
  })
}

async function countsByTable(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    Object.keys(EXPECTED_COUNTS).map(async (table) => {
      const rows = await sql.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${table} where workspace_id = $1`,
        [workspaceId],
      )
      return [table, rows[0]?.n ?? -1] as const
    }),
  )
  return Object.fromEntries(entries)
}

beforeAll(async () => {
  sql = openDatabase()
  await runSeed()

  const [ws] = await sql<{ id: string }[]>`
    select id from workspaces where slug = ${WORKSPACE_SLUG}`
  if (ws === undefined) throw new Error('seed did not create the demo workspace')
  workspaceId = ws.id
}, 180_000)

afterAll(async () => {
  await sql.end()
})

describe('seed', () => {
  it('creates the demo workspace with Indonesian settings', async () => {
    const [ws] = await sql<
      { name: string; plan: string; timezone: string; autonomous_mode: boolean }[]
    >`
      select name, plan, timezone, autonomous_mode from workspaces where id = ${workspaceId}`

    expect(ws?.name).toBe('PT Maju Bersama Digital')
    expect(ws?.timezone).toBe('Asia/Jakarta')
    // CLAUDE.md rule 5: autonomous mode ships false.
    expect(ws?.autonomous_mode).toBe(false)
  })

  it('populates every table with the expected number of rows', async () => {
    expect(await countsByTable()).toEqual(EXPECTED_COUNTS)
  })

  it('creates the three roles as real auth users', async () => {
    const rows = await sql<{ role: string; email: string }[]>`
      select m.role, u.email
      from memberships m
      join auth.users u on u.id = m.user_id
      where m.workspace_id = ${workspaceId}
      order by u.email`

    expect(rows.map((r) => r.role).sort()).toEqual(['manager', 'owner', 'sales'])
    // Confirmed up front, so the magic link works on the first attempt.
    const unconfirmed = await sql<{ n: number }[]>`
      select count(*)::int as n
      from memberships m join auth.users u on u.id = m.user_id
      where m.workspace_id = ${workspaceId} and u.email_confirmed_at is null`
    expect(unconfirmed[0]?.n).toBe(0)
  })

  it('represents every lead status', async () => {
    const rows = await sql<{ status: string }[]>`
      select distinct status from leads where workspace_id = ${workspaceId} order by status`
    expect(rows.map((r) => r.status).sort()).toEqual([...ALL_LEAD_STATUSES].sort())
  })

  it('spreads scores across all three categories, matching the SPEC bands', async () => {
    const rows = await sql<{ category: string; n: number; lo: number; hi: number }[]>`
      select category, count(*)::int as n, min(score)::int as lo, max(score)::int as hi
      from leads where workspace_id = ${workspaceId} group by category`

    const byCategory = new Map(rows.map((r) => [r.category, r]))
    expect([...byCategory.keys()].sort()).toEqual(['cold', 'hot', 'warm'])

    // docs/SPEC.md §4: 80-100 hot, 50-79 warm, 0-49 cold.
    expect(byCategory.get('hot')?.lo).toBeGreaterThanOrEqual(80)
    expect(byCategory.get('warm')?.lo).toBeGreaterThanOrEqual(50)
    expect(byCategory.get('warm')?.hi).toBeLessThanOrEqual(79)
    expect(byCategory.get('cold')?.hi).toBeLessThanOrEqual(49)
  })

  it('stores score_factors that add up to the stored score', async () => {
    const rows = await sql<{ score: number; score_factors: unknown }[]>`
      select score, score_factors from leads where workspace_id = ${workspaceId}`

    expect(rows.length).toBe(60)
    for (const row of rows) {
      const factors = row.score_factors
      if (!Array.isArray(factors)) throw new Error('score_factors is not an array')
      expect(factors.length).toBe(6)

      let weightTotal = 0
      let weighted = 0
      for (const factor of factors) {
        const f: { weight?: unknown; score?: unknown; evidence?: unknown } = factor
        if (typeof f.weight !== 'number' || typeof f.score !== 'number') {
          throw new Error('score factor is missing weight or score')
        }
        expect(typeof f.evidence).toBe('string')
        weightTotal += f.weight
        weighted += f.score * f.weight
      }
      // SPEC §4 weights: 25 + 25 + 15 + 15 + 10 + 10.
      expect(weightTotal).toBe(100)
      expect(Math.round(weighted / 100)).toBe(row.score)
    }
  })

  it('writes score reasons in Bahasa Indonesia', async () => {
    const rows = await sql<{ score_reason: string }[]>`
      select score_reason from leads where workspace_id = ${workspaceId}`
    expect(rows.every((r) => r.score_reason.length > 60)).toBe(true)
    expect(
      rows.some((r) => /prospek|industri|karyawan|kontak/i.test(r.score_reason)),
    ).toBe(true)
  })

  it('stores canonical E.164 phones, keeping the scraped 08xx form in raw', async () => {
    const contacts = await sql<{ phone: string }[]>`
      select phone from contacts where workspace_id = ${workspaceId} and phone is not null`
    expect(contacts.length).toBe(60)
    expect(contacts.every((c) => /^\+628\d{8,11}$/.test(c.phone))).toBe(true)

    const raws = await sql<{ phone_raw: string }[]>`
      select raw->>'phone_raw' as phone_raw from companies where workspace_id = ${workspaceId}`
    expect(raws.length).toBe(60)
    expect(raws.every((r) => /^08\d{8,11}$/.test(r.phone_raw))).toBe(true)
  })

  it('leaves drafts for the approval queue and replies for the inbox', async () => {
    const [pending] = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where workspace_id = ${workspaceId} and status in ('pending_approval', 'needs_input')`
    expect(pending?.n).toBe(16)

    const [inbound] = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where workspace_id = ${workspaceId} and direction = 'in'`
    expect(inbound?.n).toBe(20)
  })

  it('is idempotent — a second run changes nothing', async () => {
    const before = await countsByTable()
    const [leadBefore] = await sql<{ id: string; score: number }[]>`
      select id, score from leads where workspace_id = ${workspaceId} order by id limit 1`

    await runSeed()

    // The workspace is rebuilt, so re-read its id rather than assuming.
    const [ws] = await sql<{ id: string }[]>`
      select id from workspaces where slug = ${WORKSPACE_SLUG}`
    expect(ws?.id).toBe(workspaceId)

    expect(await countsByTable()).toEqual(before)

    // Deterministic: the same lead keeps the same id and the same score.
    const [leadAfter] = await sql<{ id: string; score: number }[]>`
      select id, score from leads where workspace_id = ${workspaceId} order by id limit 1`
    expect(leadAfter?.id).toBe(leadBefore?.id)
    expect(leadAfter?.score).toBe(leadBefore?.score)
  }, 180_000)
})
