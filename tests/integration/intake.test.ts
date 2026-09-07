import type postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDailyIntake } from '@/lib/db/queries/dashboard'
import { jakartaDayKey } from '@/lib/format'

import { openDatabase } from './helpers'

/**
 * The daily intake buckets behind the dashboard card and `pnpm leads:stats`.
 *
 * Two properties carry the weight, and neither is visible from the unit suite
 * because both are about what Postgres does with a timestamptz:
 *
 *  1. **A day with no run is a zero, not a missing row.** During the scraping
 *     week a gap means the machine was asleep or the workflow was not Active.
 *     A chart that silently closes the gap would report a lie by omission.
 *  2. **Bucketing agrees between Postgres and TypeScript.** The query buckets
 *     with `at time zone 'Asia/Jakarta'`; the bucket list is built in JS with
 *     `jakartaDayKey`. If those two ever disagree, rows land in a bucket nobody
 *     renders and the totals quietly drop them.
 *
 * Its own workspace, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'intake-test-workspace'
const OTHER_SLUG = 'intake-test-other'

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string

/** The Jakarta day key `offset` days before today. */
function dayKeyAgo(offset: number): string {
  return jakartaDayKey(new Date(Date.now() - offset * 86_400_000))
}

/**
 * Inserts `count` leads stamped mid-morning on that Jakarta day.
 *
 * 06:00 +07:00 is chosen so the row is unambiguously inside the day in Jakarta
 * and still inside it in UTC terms — a midnight stamp would sit exactly on the
 * boundary this test is meant to check.
 */
async function seedLeads(targetWorkspace: string, dayKey: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sql`
      insert into leads (workspace_id, status, created_at)
      values (${targetWorkspace}, 'new', ${`${dayKey}T06:00:00+07:00`}::timestamptz)`
  }
}

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER_SLUG})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Intake Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Intake Other', ${OTHER_SLUG}) returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')

  workspaceId = ws.id
  otherWorkspaceId = other.id

  // today: 3, yesterday: 1, two days ago: 0 (the gap), six days ago: 2.
  await seedLeads(workspaceId, dayKeyAgo(0), 3)
  await seedLeads(workspaceId, dayKeyAgo(1), 1)
  await seedLeads(workspaceId, dayKeyAgo(6), 2)

  // Outside a 7-day window, and must not be counted by it.
  await seedLeads(workspaceId, dayKeyAgo(9), 5)

  // Another tenant, same days. The Drizzle handle bypasses RLS, so this is the
  // case that proves the workspace filter is really in the query.
  await seedLeads(otherWorkspaceId, dayKeyAgo(0), 40)
  await seedLeads(otherWorkspaceId, dayKeyAgo(3), 40)
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER_SLUG})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('getDailyIntake', () => {
  it('returns exactly one bucket per day, oldest first, ending today', async () => {
    const days = await getDailyIntake(workspaceId, 7)

    expect(days).toHaveLength(7)
    expect(days.map((d) => d.day)).toEqual([
      dayKeyAgo(6), dayKeyAgo(5), dayKeyAgo(4), dayKeyAgo(3),
      dayKeyAgo(2), dayKeyAgo(1), dayKeyAgo(0),
    ])
  })

  it('counts each day into the bucket Postgres and TypeScript both agree on', async () => {
    const days = await getDailyIntake(workspaceId, 7)
    const byDay = new Map(days.map((d) => [d.day, d.count]))

    expect(byDay.get(dayKeyAgo(0))).toBe(3)
    expect(byDay.get(dayKeyAgo(1))).toBe(1)
    expect(byDay.get(dayKeyAgo(6))).toBe(2)
  })

  it('renders a day with no run as a zero rather than dropping the row', async () => {
    const days = await getDailyIntake(workspaceId, 7)
    const quiet = days.find((d) => d.day === dayKeyAgo(2))

    expect(quiet).toBeDefined()
    expect(quiet?.count).toBe(0)
  })

  it('excludes leads older than the window', async () => {
    const week = await getDailyIntake(workspaceId, 7)
    const fortnight = await getDailyIntake(workspaceId, 14)

    expect(week.reduce((sum, d) => sum + d.count, 0)).toBe(6)
    expect(fortnight.reduce((sum, d) => sum + d.count, 0)).toBe(11)
  })

  it('never counts another workspace, even though this connection bypasses RLS', async () => {
    const days = await getDailyIntake(workspaceId, 7)
    const total = days.reduce((sum, d) => sum + d.count, 0)

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from leads where workspace_id = ${otherWorkspaceId}`

    expect(row?.n).toBe(80)
    expect(total).toBe(6)
  })

  it('sums to the leads actually created inside the window', async () => {
    const days = await getDailyIntake(workspaceId, 7)
    const total = days.reduce((sum, d) => sum + d.count, 0)

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n
      from leads
      where workspace_id = ${workspaceId}
        and (created_at at time zone 'Asia/Jakarta')::date
            >= (now() at time zone 'Asia/Jakarta')::date - 6`

    expect(total).toBe(row?.n)
  })
})
