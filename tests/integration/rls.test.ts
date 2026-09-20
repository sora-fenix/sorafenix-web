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

// -----------------------------------------------------------------------------
// Privilege escalation inside one's own workspace
// -----------------------------------------------------------------------------

describe('privileged workspace columns', () => {
  // `workspaces_update_owner` lets an owner update their own workspace row, and
  // 0003 granted UPDATE at the table level, which covers every column. So until
  // 0011 an owner could raise their own sending limits with nothing but the anon
  // key. The policy was never the problem and these cases do not test it; they
  // test the column grants underneath it.

  const PRIVILEGED = [
    ['plan', `plan = 'business'`],
    ['daily_email_limit', `daily_email_limit = 100000`],
    ['daily_wa_limit', `daily_wa_limit = 100000`],
    ['autonomous_mode', `autonomous_mode = true`],
  ] as const

  for (const [column, assignment] of PRIVILEGED) {
    it(`owner cannot rewrite ${column} on their own workspace`, async () => {
      const message = await probeRejection(
        reserved,
        alpha.userId,
        `update workspaces set ${assignment} where id = $1`,
        [alpha.workspaceId],
      )
      expect(message).toMatch(/permission denied/i)
    })
  }

  it('leaves the send guard reading the limit the operator set', async () => {
    // The point of the four cases above, stated as the outcome that matters:
    // src/lib/outreach/send-context.ts reads these two columns on every send.
    const [row] = await reserved<{ email: number; wa: number }[]>`
      select daily_email_limit as email, daily_wa_limit as wa
      from workspaces where id = ${alpha.workspaceId}`
    expect(row?.email).toBe(200)
    expect(row?.wa).toBe(100)
  })

  it('still lets an owner edit the settings that are genuinely theirs', async () => {
    // The fix must not be a blanket revoke: renaming a workspace and setting its
    // timezone are owner settings, and a future settings form depends on them.
    const updated = await asUser(reserved, alpha.userId, () =>
      reserved.unsafe(
        `update workspaces set name = $1, timezone = $2 where id = $3 returning id`,
        ['Renamed by owner', 'Asia/Makassar', alpha.workspaceId],
      ),
    )
    expect(updated.length).toBe(1)
  })

  it('grants UPDATE on an allowlist, not a denylist', async () => {
    // Postgres sums table-level and column-level privileges, so a column REVOKE
    // against a surviving table-level GRANT is a no-op that still reads like a
    // fix. This asserts the shape of the grant itself, which is the part that
    // was wrong, and fails if anyone reinstates the table-level grant.
    const [row] = await reserved<{
      plan: boolean
      email: boolean
      name: boolean
    }[]>`
      select has_column_privilege('authenticated', 'workspaces', 'plan', 'UPDATE') as plan,
             has_column_privilege('authenticated', 'workspaces', 'daily_email_limit', 'UPDATE') as email,
             has_column_privilege('authenticated', 'workspaces', 'name', 'UPDATE') as name`
    expect(row?.plan).toBe(false)
    expect(row?.email).toBe(false)
    expect(row?.name).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Membership writes belong to the owner alone
// -----------------------------------------------------------------------------

describe('membership writes are owner-only', () => {
  // `permissions.ts` gives `member:manage` to owner alone and the unit suite
  // asserts a manager does not have it. Until 0012 the policies admitted
  // ARRAY['owner', 'manager'], so a manager who skipped our UI and talked to
  // PostgREST directly got the power the matrix denies. These cases pin the two
  // layers together; the matrix side is covered by tests/unit/permissions.test.ts.
  let managerId: string
  let outsiderId: string

  beforeAll(async () => {
    // Privileged setup, not the thing under test.
    const [manager] = await reserved<{ id: string }[]>`
      insert into auth.users (id, instance_id, aud, role, email)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
              'authenticated', 'authenticated', 'rls-manager@example.test')
      returning id`
    const [outsider] = await reserved<{ id: string }[]>`
      insert into auth.users (id, instance_id, aud, role, email)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
              'authenticated', 'authenticated', 'rls-outsider@example.test')
      returning id`
    if (manager === undefined || outsider === undefined) {
      throw new Error('manager fixture setup failed')
    }
    managerId = manager.id
    outsiderId = outsider.id

    await reserved`insert into memberships (workspace_id, user_id, role)
                   values (${alpha.workspaceId}, ${managerId}, 'manager')`
  })

  it('manager cannot promote themselves to owner', async () => {
    await asUser(reserved, managerId, async () => {
      const updated = await reserved.unsafe(
        `update memberships set role = 'owner'
         where workspace_id = $1 and user_id = $2 returning id`,
        [alpha.workspaceId, managerId],
      )
      expect(updated.length).toBe(0)
    })

    const [row] = await reserved<{ role: string }[]>`
      select role from memberships
      where workspace_id = ${alpha.workspaceId} and user_id = ${managerId}`
    expect(row?.role).toBe('manager')
  })

  it('manager cannot demote the owner', async () => {
    // The takeover half: the old UPDATE policy constrained who was acting, never
    // which row was touched.
    await asUser(reserved, managerId, async () => {
      const updated = await reserved.unsafe(
        `update memberships set role = 'viewer'
         where workspace_id = $1 and user_id = $2 returning id`,
        [alpha.workspaceId, alpha.userId],
      )
      expect(updated.length).toBe(0)
    })

    const [row] = await reserved<{ role: string }[]>`
      select role from memberships
      where workspace_id = ${alpha.workspaceId} and user_id = ${alpha.userId}`
    expect(row?.role).toBe('owner')
  })

  it('manager cannot invite a new member', async () => {
    const message = await probeRejection(
      reserved,
      managerId,
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, 'sales')`,
      [alpha.workspaceId, outsiderId],
    )
    expect(message).toMatch(/row-level security/i)
  })

  it('manager cannot remove a member', async () => {
    await asUser(reserved, managerId, async () => {
      const deleted = await reserved.unsafe(
        `delete from memberships where workspace_id = $1 and user_id = $2 returning id`,
        [alpha.workspaceId, alpha.userId],
      )
      expect(deleted.length).toBe(0)
    })
  })

  it('manager can still see who is in the workspace', async () => {
    // memberships_select_member is deliberately untouched — tightening writes
    // must not blind the members list.
    const rows = await asUser(reserved, managerId, () =>
      reserved.unsafe(`select id from memberships where workspace_id = $1`, [
        alpha.workspaceId,
      ]),
    )
    expect(rows.length).toBeGreaterThan(1)
  })

  it('owner can still manage members', async () => {
    // The fix must not lock the legitimate path: without this, a policy that
    // rejects everyone would pass every case above.
    const updated = await asUser(reserved, alpha.userId, () =>
      reserved.unsafe(
        `update memberships set role = 'sales'
         where workspace_id = $1 and user_id = $2 returning id`,
        [alpha.workspaceId, managerId],
      ),
    )
    expect(updated.length).toBe(1)

    // Put it back so later cases in this file see the fixture they expect.
    await reserved`update memberships set role = 'manager'
                   where workspace_id = ${alpha.workspaceId} and user_id = ${managerId}`
  })
})
