import 'server-only'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { serverEnv } from '@/lib/env'

import * as schema from './schema'

/**
 * Drizzle connection.
 *
 * IMPORTANT — this connects with DATABASE_URL, which is a privileged role and
 * therefore BYPASSES Row Level Security. RLS (see drizzle/0001_rls.sql) protects
 * the Supabase-client path used by the browser; it does not protect this one.
 * Every query written against this handle must filter by `workspace_id`
 * explicitly (CLAUDE.md rule 6). Reviewers: treat a missing workspace filter here
 * as a security bug, not a style nit.
 */

declare global {
  // Reused across dev HMR reloads so Next does not open a new pool per edit.
  var __soraPostgresClient: postgres.Sql | undefined
}

function createClient(): postgres.Sql {
  return postgres(serverEnv().DATABASE_URL, {
    // Supabase's transaction pooler does not support prepared statements.
    prepare: false,
    max: 10,
    idle_timeout: 20,
  })
}

const client: postgres.Sql =
  serverEnv().NODE_ENV === 'production'
    ? createClient()
    : (globalThis.__soraPostgresClient ??= createClient())

export const db = drizzle(client, { schema })
export { schema }
