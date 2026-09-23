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
// Machine state is readable, never writable
// -----------------------------------------------------------------------------

describe('scrape_cursors grants', () => {
  // ADR 0001 §4: a cursor is written by the planner over the privileged
  // connection and read by a coverage panel. Nobody edits one. So it is the only
  // table in WORKSPACE_SCOPED_TABLES that deviates from the uniform
  // `_member_all` grant in 0003 — SELECT to `authenticated`, and nothing else.
  //
  // Asserted with has_table_privilege for exactly the reason the 0011 cases
  // above use has_column_privilege: Supabase's default ACL grants ALL on every
  // new table to anon, authenticated and service_role, so a bare `GRANT SELECT`
  // is a no-op that still reads like a fix. The REVOKE in 0015 is what makes it
  // real, and this case is what fails if anyone drops it.

  it('grants SELECT to a member and withholds every write', async () => {
    const [row] = await reserved<
      {
        can_select: boolean
        can_insert: boolean
        can_update: boolean
        can_delete: boolean
        anon_select: boolean
        anon_insert: boolean
      }[]
    >`
      select has_table_privilege('authenticated', 'scrape_cursors', 'SELECT') as can_select,
             has_table_privilege('authenticated', 'scrape_cursors', 'INSERT') as can_insert,
             has_table_privilege('authenticated', 'scrape_cursors', 'UPDATE') as can_update,
             has_table_privilege('authenticated', 'scrape_cursors', 'DELETE') as can_delete,
             has_table_privilege('anon', 'scrape_cursors', 'SELECT') as anon_select,
             has_table_privilege('anon', 'scrape_cursors', 'INSERT') as anon_insert`
    expect(row?.can_select).toBe(true)
    expect(row?.can_insert).toBe(false)
    expect(row?.can_update).toBe(false)
    expect(row?.can_delete).toBe(false)

    // 0015 revokes `anon` as well, and its comment argues that line earns its
    // keep. Without these two the line could be deleted and the suite would stay
    // green. No policy admits anon, so RLS would still stop it — but a
    // table-level grant left standing for an unauthenticated role means one
    // forgotten policy is the whole breach.
    expect(row?.anon_select).toBe(false)
    expect(row?.anon_insert).toBe(false)
  })

  it('stops a member forging a cursor in their own workspace', async () => {
    // The grant stated as the outcome that matters. Forging a fingerprint is the
    // interesting attack: it makes a campaign re-walk ground it has already paid
    // for, on the Serper account every tenant shares.
    const message = await probeRejection(
      reserved,
      alpha.userId,
      `insert into scrape_cursors
         (workspace_id, campaign_id, space_fingerprint, space_size, lap_started_on)
       values ($1, gen_random_uuid(), 'forged', 1, '2026-09-07')`,
      [alpha.workspaceId],
    )
    expect(message).toMatch(/permission denied/i)
  })

  it('stops a member rewinding their own cursor', async () => {
    const message = await probeRejection(
      reserved,
      alpha.userId,
      `update scrape_cursors set position = 0, lap = 0 where workspace_id = $1`,
      [alpha.workspaceId],
    )
    expect(message).toMatch(/permission denied/i)
  })

  it('still lets a member see their own coverage', async () => {
    // The restriction must not blind the panel it exists to serve: without this,
    // a table nobody could read at all would pass every case above.
    const rows = await asUser(reserved, alpha.userId, () =>
      reserved.unsafe(
        `select position, lap, space_size from scrape_cursors where workspace_id = $1`,
        [alpha.workspaceId],
      ),
    )
    expect(rows.length).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// Membership writes belong to the owner alone
// -----------------------------------------------------------------------------

describe('membership writes', () => {
  // Two rules, landed a day apart, and the cases below hold both at once:
  //
  //   0012 — changing a role and removing a member belong to the owner alone.
  //          Until then the policies admitted ARRAY['owner', 'manager'], so a
  //          manager who skipped our UI and talked to PostgREST directly could
  //          promote themselves and demote the owner.
  //   0013 — a manager may invite (owner decision 2026-09-21), but never at
  //          `owner`, or the first rule is reachable through a second account.
  //
  // The matrix half is in tests/unit/permissions.test.ts. It cannot express the
  // `owner` ceiling, because `can()` never sees the role being granted — that
  // half only exists here.
  let managerId: string
  let outsiderId: string
  let outsider2Id: string
  let outsider3Id: string
  let outsider4Id: string

  beforeAll(async () => {
    // Privileged setup, not the thing under test.
    const [manager] = await reserved<{ id: string }[]>`
      insert into auth.users (id, instance_id, aud, role, email)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
              'authenticated', 'authenticated', 'rls-manager@example.test')
      returning id`
    // Four, because a successful invite consumes one: the unique index on
    // (workspace_id, user_id) means the same person cannot be invited twice.
    const outsiders = await reserved<{ id: string }[]>`
      insert into auth.users (id, instance_id, aud, role, email)
      select gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
             'authenticated', 'authenticated', 'rls-outsider-' || n || '@example.test'
      from generate_series(1, 4) as n
      returning id`
    const [first, second, third, fourth] = outsiders
    if (
      manager === undefined ||
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error('manager fixture setup failed')
    }
    managerId = manager.id
    outsiderId = first.id
    outsider2Id = second.id
    outsider3Id = third.id
    outsider4Id = fourth.id

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

  it('manager can invite a member below owner', async () => {
    const inserted = await asUser(reserved, managerId, () =>
      reserved.unsafe(
        `insert into memberships (workspace_id, user_id, role)
         values ($1, $2, 'sales') returning id`,
        [alpha.workspaceId, outsiderId],
      ),
    )
    expect(inserted.length).toBe(1)
  })

  it('manager can invite another manager, which is lateral not upward', async () => {
    const inserted = await asUser(reserved, managerId, () =>
      reserved.unsafe(
        `insert into memberships (workspace_id, user_id, role)
         values ($1, $2, 'manager') returning id`,
        [alpha.workspaceId, outsider2Id],
      ),
    )
    expect(inserted.length).toBe(1)
  })

  it('manager cannot mint an owner', async () => {
    // Without this clause the 0012 fix is cosmetic: a manager barred from
    // promoting themselves could invite a second account as owner and sign in
    // as it, reaching workspace:manage and the UU PDP hard-delete by another
    // door. This is the half permissions.ts structurally cannot express.
    const message = await probeRejection(
      reserved,
      managerId,
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')`,
      [alpha.workspaceId, outsider3Id],
    )
    expect(message).toMatch(/row-level security/i)

    const [row] = await reserved<{ n: number }[]>`
      select count(*)::int as n from memberships
      where workspace_id = ${alpha.workspaceId} and user_id = ${outsider3Id}`
    expect(row?.n).toBe(0)
  })

  it('owner can still invite an owner', async () => {
    // The ceiling applies to managers, not to the owner granting co-ownership.
    const inserted = await asUser(reserved, alpha.userId, () =>
      reserved.unsafe(
        `insert into memberships (workspace_id, user_id, role)
         values ($1, $2, 'owner') returning id`,
        [alpha.workspaceId, outsider3Id],
      ),
    )
    expect(inserted.length).toBe(1)
  })

  it('sales cannot invite anyone', async () => {
    // outsiderId was invited as `sales` above, so this is a real sales member.
    const message = await probeRejection(
      reserved,
      outsiderId,
      `insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')`,
      [alpha.workspaceId, outsider4Id],
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
