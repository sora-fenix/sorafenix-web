/**
 * Registers the WAHA session a workspace sends and receives WhatsApp on.
 *
 *   pnpm wa:connect --workspace data-riil
 *   pnpm wa:connect --workspace data-riil --session data-riil
 *
 * One-time setup, the same shape as `pnpm campaign:create`: the transport cannot
 * work until `integrations` says which session belongs to this workspace, and the
 * inbound webhook resolves the tenant from exactly that row. Without it, `wa:send`
 * reports `not_connected` and every inbound event is answered 200 and dropped as
 * unattributable.
 *
 * THE SESSION NAME IS THE TENANT KEY. Migration 0018 puts a unique index on it
 * across all workspaces, so a second workspace claiming a session fails here, at
 * setup, rather than quietly making two tenants' replies indistinguishable. Give
 * each workspace its own session on a shared WAHA instance; `default` is fine only
 * while there is one workspace.
 *
 * Idempotent by (workspace, provider): re-running with the same session prints the
 * existing row instead of creating a second one.
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

const DEFAULT_SESSION = 'default'

/** Reads `--flag value` out of argv. Absent flag and bare flag both mean "unset". */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

/** Postgres 23505, wherever the driver put it. Same walk as lib/outreach/draft.ts. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    if (Reflect.get(current, 'code') === '23505') return true
    current = Reflect.get(current, 'cause')
  }
  return false
}

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const wantedSlug = flag('workspace')
  const session = flag('session') ?? DEFAULT_SESSION

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })
  const db = drizzle(sql, { schema })

  try {
    const workspaces = await db
      .select({ id: schema.workspaces.id, slug: schema.workspaces.slug, name: schema.workspaces.name })
      .from(schema.workspaces)

    const candidates =
      wantedSlug === undefined ? workspaces : workspaces.filter((w) => w.slug === wantedSlug)

    const workspace = candidates[0]
    if (workspace === undefined || candidates.length > 1) {
      // Guessing which tenant owns a WhatsApp session is exactly the mistake the
      // unique index exists to make impossible.
      console.error(
        workspace === undefined
          ? `No workspace matched${wantedSlug === undefined ? '' : ` --workspace ${wantedSlug}`}.`
          : 'More than one workspace exists. Re-run with --workspace <slug>.',
      )
      for (const w of workspaces) console.error(`  ${w.slug.padEnd(24)} ${w.name}`)
      process.exitCode = 1
      return
    }

    // rule 6: every query on this handle filters workspace_id.
    const [existing] = await db
      .select({ id: schema.integrations.id, meta: schema.integrations.meta })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.workspaceId, workspace.id),
          eq(schema.integrations.provider, 'whatsapp'),
        ),
      )
      .limit(1)

    try {
      await db
        .insert(schema.integrations)
        .values({
          workspaceId: workspace.id,
          provider: 'whatsapp',
          status: 'connected',
          // Non-secret metadata only. The WAHA base URL and API key are
          // instance-wide and live in the environment;
          // `credentials_encrypted` stays reserved for the Cloud API adapter,
          // which has a per-workspace token.
          meta: { session, transport: 'waha' },
        })
        .onConflictDoUpdate({
          target: [schema.integrations.workspaceId, schema.integrations.provider],
          set: { status: 'connected', meta: { session, transport: 'waha' }, updatedAt: new Date() },
        })
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error

      // Which workspace holds it. Named so the operator does not have to open psql
      // to find out what they collided with. Written against the driver rather than
      // the query builder because `sql` here is the postgres client, not Drizzle's
      // template tag.
      const owners = await sql<{ slug: string; session: string | null }[]>`
        select w.slug, i.meta->>'session' as session
        from integrations i
        join workspaces w on w.id = i.workspace_id
        where i.provider = 'whatsapp' and i.meta->>'session' is not null
        order by w.slug`

      console.error(`Session "${session}" is already registered by another workspace.`)
      console.error('A WAHA session belongs to exactly one workspace (migration 0018), because')
      console.error('inbound events are attributed by session name. Pick a different session.')
      for (const owner of owners) {
        console.error(`  ${owner.slug.padEnd(24)} session ${owner.session ?? ''}`)
      }
      process.exitCode = 1
      return
    }

    const before = existing?.meta ?? null
    console.log(`${existing === undefined ? 'Connected' : 'Updated'} WhatsApp for ${workspace.slug}`)
    console.log(`  workspace  ${workspace.slug} (${workspace.name})`)
    console.log(`  session    ${session}`)
    if (existing !== undefined) console.log(`  previous   ${JSON.stringify(before)}`)
    console.log('')
    console.log('Point WAHA at this app, then send with `pnpm wa:send <messageId>`:')
    console.log('  webhook URL   <app>/api/webhooks/whatsapp')
    console.log('  events        message, message.ack')
    console.log('  HMAC          sha512, key = WAHA_WEBHOOK_HMAC_SECRET from .env.local')
    console.log('')
    console.log('These must be set in .env.local for the transport to work:')
    console.log(`  WAHA_BASE_URL             ${env.WAHA_BASE_URL ?? '(missing)'}`)
    console.log(`  WAHA_API_KEY              ${env.WAHA_API_KEY === undefined ? '(missing)' : '(set)'}`)
    console.log(
      `  WAHA_WEBHOOK_HMAC_SECRET  ${env.WAHA_WEBHOOK_HMAC_SECRET === undefined ? '(missing)' : '(set)'}`,
    )
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
