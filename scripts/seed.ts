/**
 * Seeds one demo workspace and attaches an existing Supabase Auth user to it as
 * owner, so the app is demo-able without any external service.
 *
 *   pnpm db:seed you@company.com
 *
 * The user must already exist in Supabase Auth — sign in once through the magic
 * link at /login, then run this. This script talks to Postgres directly rather
 * than through lib/db/drizzle.ts, because that module imports `server-only`,
 * which deliberately refuses to load outside the Next.js server runtime.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { memberships, workspaces } from '../lib/db/schema'

// Must run before lib/env.ts is loaded, hence the dynamic import below: that
// module validates the environment the moment it is evaluated.
config({ path: '.env.local', quiet: true })

const DEMO_WORKSPACE = { name: 'Workspace Demo', slug: 'demo' }

async function loadEnv() {
  const { publicEnv, serverEnv } = await import('../lib/env')
  return { publicEnv, env: serverEnv() }
}

async function findUserIdByEmail(
  email: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<string> {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (error !== null) {
    throw new Error(`Could not list Supabase users: ${error.message}`)
  }

  const match = data.users.find(
    (user) => user.email?.toLowerCase() === email.toLowerCase(),
  )
  if (match === undefined) {
    throw new Error(
      `No Supabase Auth user with email "${email}". Sign in once at /login, then re-run.`,
    )
  }

  return match.id
}

async function main(): Promise<void> {
  const email = process.argv[2]
  if (email === undefined) {
    throw new Error('Usage: pnpm db:seed <email-of-existing-supabase-user>')
  }

  const { publicEnv, env } = await loadEnv()

  const userId = await findUserIdByEmail(
    email,
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  )

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })
  const db = drizzle(sql, { schema: { workspaces, memberships } })

  try {
    const [workspace] = await db
      .insert(workspaces)
      .values(DEMO_WORKSPACE)
      .onConflictDoUpdate({
        target: workspaces.slug,
        set: { name: DEMO_WORKSPACE.name, updatedAt: new Date() },
      })
      .returning()

    if (workspace === undefined) {
      throw new Error('Workspace upsert returned no row.')
    }

    await db
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId, role: 'owner' })
      .onConflictDoUpdate({
        target: [memberships.workspaceId, memberships.userId],
        set: { role: 'owner', updatedAt: new Date() },
      })

    const rows = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, userId)),
      )

    console.log(
      `Seeded workspace "${workspace.name}" (/app/${workspace.slug}) with ${email} as ${rows[0]?.role ?? 'owner'}.`,
    )
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
