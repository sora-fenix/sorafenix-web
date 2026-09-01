/**
 * Creates the campaign that real n8n-scraped leads land in, and prints its id.
 *
 *   pnpm campaign:create
 *   pnpm campaign:create --workspace maju-bersama --name "Data Riil"
 *
 * The ingestion webhook resolves a workspace from `campaign_id` and rejects an
 * unknown one with 404 — so n8n cannot post anything until a campaign exists and
 * its id is in `SORA_CAMPAIGN_ID`. This script is the shortest path from a fresh
 * local stack to that id.
 *
 * Idempotent by (workspace, name): re-running prints the existing id instead of
 * creating a second campaign, so it is safe to run whenever you forget the value.
 *
 * Talks to Postgres directly rather than through lib/db/drizzle.ts, because that
 * module imports `server-only`, which refuses to load outside the Next runtime.
 */

import { config } from 'dotenv'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '../src/lib/db/schema'

config({ path: '.env.local', quiet: true })

const DEFAULT_NAME = 'Data Riil'

/** Reads `--flag value` out of argv. Absent flag and bare flag both mean "unset". */
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

  const wantedSlug = flag('workspace')
  const name = flag('name') ?? DEFAULT_NAME

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })
  const db = drizzle(sql, { schema })

  try {
    const workspaces = await db
      .select({
        id: schema.workspaces.id,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
      })
      .from(schema.workspaces)

    const candidates =
      wantedSlug === undefined ? workspaces : workspaces.filter((w) => w.slug === wantedSlug)

    const workspace = candidates[0]
    if (workspace === undefined || candidates.length > 1) {
      // Guessing which tenant a campaign belongs to is exactly the kind of
      // mistake that puts one workspace's leads inside another's.
      console.error(
        workspace === undefined
          ? `No workspace matched${wantedSlug === undefined ? '' : ` --workspace ${wantedSlug}`}.`
          : 'More than one workspace exists. Re-run with --workspace <slug>.',
      )
      for (const w of workspaces) console.error(`  ${w.slug.padEnd(24)} ${w.name}`)
      process.exitCode = 1
      return
    }

    // Every query on the Drizzle handle filters by workspace_id (rule 6): this
    // connection is privileged and bypasses RLS.
    const [existing] = await db
      .select({ id: schema.campaigns.id, status: schema.campaigns.status })
      .from(schema.campaigns)
      .where(
        and(eq(schema.campaigns.workspaceId, workspace.id), eq(schema.campaigns.name, name)),
      )
      .limit(1)

    const campaign =
      existing ??
      (
        await db
          .insert(schema.campaigns)
          .values({
            workspaceId: workspace.id,
            name,
            status: 'running',
            target: { source: 'n8n', note: 'Real leads from the lead-hunter workflow.' },
          })
          .returning({ id: schema.campaigns.id, status: schema.campaigns.status })
      )[0]

    if (campaign === undefined) {
      throw new Error('Insert returned no row')
    }

    console.log(`${existing === undefined ? 'Created' : 'Reusing'} campaign "${name}"`)
    console.log(`  workspace  ${workspace.slug} (${workspace.name})`)
    console.log(`  status     ${campaign.status}`)
    console.log('\nPut this in .env.local, then restart n8n with `pnpm n8n:start`:\n')
    console.log(`SORA_CAMPAIGN_ID="${campaign.id}"`)
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
