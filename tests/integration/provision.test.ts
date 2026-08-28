import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { provisionWorkspace } from '@/lib/workspace/provision'

import { openDatabase } from './helpers'

/**
 * Workspace provisioning against real Postgres.
 *
 * The properties worth proving here are the ones a unit test cannot reach: that
 * the workspace and its owner membership are written atomically, and that slug
 * uniqueness is decided by the index rather than by a hopeful select.
 *
 * Its own auth users and its own slug prefix, cleaned up afterwards — seed.test.ts
 * rebuilds `maju-bersama` and asserts exact counts, so this suite stays well away
 * from it.
 */

const PREFIX = 'provision-test'
const NAME = 'Provision Test Workspace'

/** What NAME slugifies to, and therefore the slug the first insert should claim. */
const BASE_SLUG = 'provision-test-workspace'

let sql: postgres.Sql
let userId: string

async function createAuthUser(tag: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${`${PREFIX}-${tag}@example.test`})
    returning id`
  if (user === undefined) throw new Error('auth user fixture failed')
  return user.id
}

async function cleanUp(): Promise<void> {
  // Workspaces cascade to memberships; auth.users cascades to memberships too.
  await sql`delete from workspaces where slug like ${`${BASE_SLUG}%`}`
  await sql`delete from auth.users where email like ${`${PREFIX}-%`}`
}

beforeAll(async () => {
  sql = openDatabase()
})

afterAll(async () => {
  await cleanUp()
  await sql.end()
  // lib/db/drizzle.ts caches its pool on globalThis outside production; without
  // closing it the Vitest process would not exit.
  await globalThis.__soraPostgresClient?.end()
})

beforeEach(async () => {
  await cleanUp()
  userId = await createAuthUser('owner')
})

describe('provisionWorkspace', () => {
  it('creates the workspace and makes the caller its owner', async () => {
    const result = await provisionWorkspace({ userId, name: NAME })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.name).toBe(NAME)
    expect(result.value.slug).toBe(BASE_SLUG)

    const members = await sql<{ user_id: string; role: string }[]>`
      select user_id, role from memberships where workspace_id = ${result.value.id}`

    expect(members).toHaveLength(1)
    expect(members[0]?.user_id).toBe(userId)
    expect(members[0]?.role).toBe('owner')
  })

  it('applies the workspace defaults the settings screen reads', async () => {
    const result = await provisionWorkspace({ userId, name: NAME })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.plan).toBe('free')
    expect(result.value.timezone).toBe('Asia/Jakarta')
    // CLAUDE.md rule 5: autonomous mode ships false and is not wired to skip
    // approval. A new workspace must not arrive with it on.
    expect(result.value.autonomousMode).toBe(false)
  })

  it('suffixes the slug when the name is already taken, and counts from 2', async () => {
    const second = await createAuthUser('second')
    const third = await createAuthUser('third')

    const a = await provisionWorkspace({ userId, name: NAME })
    const b = await provisionWorkspace({ userId: second, name: NAME })
    const c = await provisionWorkspace({ userId: third, name: NAME })

    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return

    expect(a.value.slug).toBe(BASE_SLUG)
    expect(b.value.slug).toBe(`${BASE_SLUG}-2`)
    expect(c.value.slug).toBe(`${BASE_SLUG}-3`)

    // Same display name is fine; the slug is what has to be unique.
    expect(b.value.name).toBe(NAME)
  })

  it('rolls the workspace back when the membership cannot be written', async () => {
    // A user id that satisfies the uuid type but not the FK to auth.users. The
    // membership insert fails, and the workspace must not survive it — a
    // workspace with no owner can never be reached by anyone again.
    const orphanUser = '00000000-0000-0000-0000-0000000000ff'

    const result = await provisionWorkspace({ userId: orphanUser, name: NAME })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('db_error')

    const rows = await sql<{ id: string }[]>`
      select id from workspaces where slug like ${`${BASE_SLUG}%`}`
    expect(rows).toHaveLength(0)
  })

  it('rejects a blank name before touching the database', async () => {
    const result = await provisionWorkspace({ userId, name: '   ' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid_name')

    const rows = await sql<{ id: string }[]>`select id from workspaces where name = '   '`
    expect(rows).toHaveLength(0)
  })

  it('is reachable through the same query the app uses to resolve a workspace', async () => {
    const result = await provisionWorkspace({ userId, name: NAME })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Mirrors lib/auth/session.ts listWorkspacesForUser: membership join, not a
    // direct workspace read. If this returns nothing, the user lands back on the
    // create form after creating a workspace.
    const rows = await sql<{ slug: string; role: string }[]>`
      select w.slug, m.role
      from memberships m
      join workspaces w on w.id = m.workspace_id
      where m.user_id = ${userId}`

    expect(rows).toHaveLength(1)
    expect(rows[0]?.slug).toBe(BASE_SLUG)
    expect(rows[0]?.role).toBe('owner')
  })
})
