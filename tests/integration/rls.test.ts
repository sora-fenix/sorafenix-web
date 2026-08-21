import type postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  WORKSPACE_SCOPED_TABLES,
  asUser,
  createWorkspaceFixture,
  openDatabase,
  probeRejection,
  type Fixture,
} from './helpers'

/**
 * Proves that Row Level Security genuinely isolates workspaces, rather than
 * trusting that the policies in drizzle/0003_rls_domain.sql say the right thing.
 *
 * Everything happens inside one transaction that is rolled back, so the suite
 * leaves no rows behind and can run against a seeded database.
 */

let sql: postgres.Sql
let reserved: Awaited<ReturnType<postgres.Sql['reserve']>>
let alpha: Fixture
let beta: Fixture

beforeAll(async () => {
  sql = openDatabase()
  reserved = await sql.reserve()
  await reserved.unsafe('begin')

  alpha = await createWorkspaceFixture(reserved, 'alpha')
  beta = await createWorkspaceFixture(reserved, 'beta')
})

afterAll(async () => {
  await reserved.unsafe('rollback')
  reserved.release()
  await sql.end()
})

// -----------------------------------------------------------------------------
// The guard: no table may escape RLS
// -----------------------------------------------------------------------------

describe('RLS coverage', () => {
  it('has RLS enabled, forced, and at least one policy on every public table', async () => {
    const rows = await reserved<
      { relname: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname,
             c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname <> '__drizzle_migrations'
      order by c.relname`

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => !r.rls).map((r) => r.relname)).toEqual([])
    expect(rows.filter((r) => !r.forced).map((r) => r.relname)).toEqual([])
    expect(rows.filter((r) => r.policies === 0).map((r) => r.relname)).toEqual([])
  })

  it('covers every workspace-scoped table in the live catalogue', async () => {
    // Catches a table added to the schema but not to the sweep below.
    const rows = await reserved<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id'
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0
      order by c.relname`

    expect(rows.map((r) => r.relname)).toEqual([...WORKSPACE_SCOPED_TABLES])
  })
})

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

describe('cross-workspace reads', () => {
  it('shows a member only their own workspace, on every scoped table', async () => {
    for (const table of WORKSPACE_SCOPED_TABLES) {
      const { own, other } = await asUser(reserved, alpha.userId, async () => {
        const [mine] = await reserved.unsafe<{ n: number }[]>(
          `select count(*)::int as n from ${table} where workspace_id = $1`,
          [alpha.workspaceId],
        )
        const [theirs] = await reserved.unsafe<{ n: number }[]>(
          `select count(*)::int as n from ${table} where workspace_id = $1`,
          [beta.workspaceId],
        )
        return { own: mine?.n ?? -1, other: theirs?.n ?? -1 }
      })

      // Non-vacuous: the fixture put exactly one row in each workspace, so a
      // policy that leaked would show 1 here rather than 0.
      expect(`${table}:own=${own}`).toBe(`${table}:own=1`)
      expect(`${table}:other=${other}`).toBe(`${table}:other=0`)
    }
  })

  it('hides the other workspace row itself', async () => {
    const rows = await asUser(reserved, alpha.userId, () =>
      reserved<{ id: string }[]>`select id from workspaces`,
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(alpha.workspaceId)
    expect(ids).not.toContain(beta.workspaceId)
  })

  it('is symmetric — beta cannot see alpha either', async () => {
    const [row] = await asUser(reserved, beta.userId, () =>
      reserved<{ n: number }[]>`
        select count(*)::int as n from companies where workspace_id = ${alpha.workspaceId}`,
    )
    expect(row?.n).toBe(0)
  })

  it('shows nothing at all to a user with no membership', async () => {
    const [orphan] = await reserved<{ id: string }[]>`
      insert into auth.users (id, instance_id, aud, role, email)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
              'authenticated', 'authenticated', 'orphan@example.test')
      returning id`
    if (orphan === undefined) throw new Error('orphan fixture failed')

    const [row] = await asUser(reserved, orphan.id, () =>
      reserved<{ n: number }[]>`select count(*)::int as n from companies`,
    )
    expect(row?.n).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

describe('cross-workspace writes', () => {
  it('cannot update a row in another workspace', async () => {
    await asUser(reserved, alpha.userId, async () => {
      const updated = await reserved.unsafe(
        `update companies set name = 'hijacked' where id = $1 returning id`,
        [beta.companyId],
      )
      expect(updated.length).toBe(0)
    })

    // And the row is genuinely untouched when read with privileges.
    const [row] = await reserved<{ name: string }[]>`
      select name from companies where id = ${beta.companyId}`
    expect(row?.name).toBe('Company beta')
  })

  it('cannot delete a row in another workspace', async () => {
    await asUser(reserved, alpha.userId, async () => {
      const deleted = await reserved.unsafe(
        `delete from companies where id = $1 returning id`,
        [beta.companyId],
      )
      expect(deleted.length).toBe(0)
    })

    const [row] = await reserved<{ n: number }[]>`
      select count(*)::int as n from companies where id = ${beta.companyId}`
    expect(row?.n).toBe(1)
  })

  it('cannot insert a row into another workspace', async () => {
    const message = await probeRejection(
      reserved,
      alpha.userId,
      `insert into companies (workspace_id, name) values ($1, 'smuggled')`,
      [beta.workspaceId],
    )
    expect(message).toMatch(/row-level security/i)
  })

  it('cannot smuggle a row in by relabelling its workspace', async () => {
    const message = await probeRejection(
      reserved,
      alpha.userId,
      `update companies set workspace_id = $1 where id = $2`,
      [beta.workspaceId, alpha.companyId],
    )
    expect(message).toMatch(/row-level security/i)
  })

  it('can still write inside its own workspace', async () => {
    const inserted = await asUser(reserved, alpha.userId, () =>
      reserved.unsafe(
        `insert into companies (workspace_id, name) values ($1, 'legitimate') returning id`,
        [alpha.workspaceId],
      ),
    )
    expect(inserted.length).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// The privileged path, documented rather than assumed
// -----------------------------------------------------------------------------

describe('privileged connection', () => {
  it('bypasses RLS, which is why application code must filter by workspace_id', async () => {
    // lib/db/drizzle.ts connects with this role. This test exists so the
    // behaviour is asserted rather than folded into a comment nobody re-reads.
    const [role] = await reserved<{ bypassrls: boolean }[]>`
      select rolbypassrls as bypassrls from pg_roles where rolname = current_user`
    expect(role?.bypassrls).toBe(true)

    const [row] = await reserved<{ n: number }[]>`
      select count(*)::int as n from companies where workspace_id = ${beta.workspaceId}`
    expect(row?.n).toBe(1)
  })
})
