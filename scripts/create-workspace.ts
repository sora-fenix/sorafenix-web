/**
 * Creates a workspace from the command line, for work that must survive the seed.
 *
 *   pnpm workspace:create "Data Riil" --members-from maju-bersama
 *
 * `scripts/seed.ts` deletes and rebuilds the workspace it owns on every run, and
 * `tests/integration` runs that seed. Anything real living there — imported
 * leads above all — disappears without an error (known issue 7). A second
 * workspace is the fix, and the seed never touches one it did not create.
 *
 * In the product a workspace is created by `src/lib/workspace/provision.ts` when
 * someone with no membership signs in. That module imports `server-only` and
 * cannot load here, so the two inserts are repeated below. They are kept
 * deliberately identical: workspace and membership in one transaction, because a
 * workspace with no owner is unreachable forever and no row at all is better.
 *
 * Talks to Postgres directly for the same reason `scripts/seed.ts` does.
 */

import { config } from 'dotenv'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '../src/lib/db/schema'
import { slugCandidate, slugifyWorkspaceName } from '../src/lib/workspace/slug'

config({ path: '.env.local', quiet: true })

/** Matches provision.ts. */
const MAX_SLUG_ATTEMPTS = 25

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const name = process.argv[2]
  const membersFrom = flag('members-from')

  if (name === undefined || name.startsWith('--') || membersFrom === undefined) {
    console.error('usage: pnpm workspace:create "<name>" --members-from <existing-slug>')
    console.error('\nMemberships are copied from the named workspace, roles included.')
    console.error('A workspace nobody is a member of cannot be opened in the UI, and')
    console.error('RLS makes that first membership row unreachable from the browser.')
    process.exitCode = 1
    return
  }

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })
  const db = drizzle(sql, { schema })

  try {
    const [source] = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, membersFrom))
      .limit(1)

    if (source === undefined) {
      console.error(`No workspace with slug "${membersFrom}".`)
      process.exitCode = 1
      return
    }

    const members = await db
      .select({ userId: schema.memberships.userId, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.workspaceId, source.id))

    if (members.length === 0) {
      console.error(`"${membersFrom}" has no members to copy.`)
      process.exitCode = 1
      return
    }

    const base = slugifyWorkspaceName(name)

    const created = await db.transaction(async (tx) => {
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
        const rows = await tx
          .insert(schema.workspaces)
          .values({ name, slug: slugCandidate(base, attempt) })
          .onConflictDoNothing({ target: schema.workspaces.slug })
          .returning({ id: schema.workspaces.id, slug: schema.workspaces.slug })

        const workspace = rows[0]
        if (workspace === undefined) continue

        await tx.insert(schema.memberships).values(
          members.map((member) => ({
            workspaceId: workspace.id,
            userId: member.userId,
            role: member.role,
          })),
        )

        return workspace
      }
      return undefined
    })

    if (created === undefined) {
      console.error(`Could not find a free slug for "${name}" after ${MAX_SLUG_ATTEMPTS} tries.`)
      process.exitCode = 1
      return
    }

    console.log(`Created workspace "${name}"`)
    console.log(`  slug     ${created.slug}   →  /app/${created.slug}/dashboard`)
    console.log(`  members  ${members.length} copied from ${membersFrom}`)
    console.log(`\nNext:  pnpm campaign:create --workspace ${created.slug}`)
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
