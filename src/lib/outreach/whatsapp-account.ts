import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '@/lib/db/drizzle'
import { serverEnv } from '@/lib/env'
import { type Result, err, ok } from '@/lib/types/result'

import { type WhatsAppTransport, createWahaTransport } from './whatsapp'

/**
 * Which WhatsApp account a workspace sends from, and which workspace an inbound
 * session belongs to.
 *
 * The account lives in `integrations.meta.session` — a WAHA session name — and not
 * in the environment, because one WAHA instance serves every workspace on a
 * development machine and the session is the only thing that tells them apart.
 * `integrations.credentials_encrypted` stays empty for WAHA: the base URL and API
 * key are instance-wide, so there is nothing per-workspace to encrypt. That column
 * is reserved for the Cloud API adapter, which has a per-workspace access token.
 *
 * `meta` is `jsonb`, so it is Zod-parsed on the way out like any other boundary. A
 * row someone edited by hand into `{"session": 4}` must fail as "not connected",
 * not arrive as a number that later renders as `4@c.us`.
 */

const wahaMetaSchema = z.looseObject({
  /** WAHA session name. `default` on a single-tenant instance. */
  session: z.string().min(1).max(200),
})

export type WhatsAppAccount = {
  readonly workspaceId: string
  readonly session: string
}

export type WhatsAppAccountError = {
  /**
   * `lookup_failed` is separate from `not_connected` so a caller can tell "this
   * workspace has not connected WhatsApp" from "we could not find out". Both refuse the
   * send — it fails closed — but only one of them is the user's to fix.
   */
  readonly kind: 'not_connected' | 'lookup_failed'
  /** English: this is a machine code path, never shown to a user unchanged. */
  readonly detail: string
}

/**
 * The connected WhatsApp account for one workspace.
 *
 * `status = 'connected'` is part of the predicate rather than a field on the
 * result: a workspace whose owner disconnected WhatsApp has no account to send
 * from, and treating a disconnected row as usable is how a revoked integration
 * keeps sending for another week.
 */
export async function findWhatsAppAccount(
  workspaceId: string,
): Promise<Result<WhatsAppAccount, WhatsAppAccountError>> {
  let row: { meta: unknown } | undefined
  try {
    ;[row] = await db
      .select({ meta: schema.integrations.meta })
      .from(schema.integrations)
      // rule 6: the Drizzle handle bypasses RLS, so the workspace filter is explicit.
      .where(
        and(
          eq(schema.integrations.workspaceId, workspaceId),
          eq(schema.integrations.provider, 'whatsapp'),
          eq(schema.integrations.status, 'connected'),
        ),
      )
      .limit(1)
  } catch (error: unknown) {
    return err({
      kind: 'lookup_failed',
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  if (row === undefined) {
    return err({ kind: 'not_connected', detail: 'no connected whatsapp integration' })
  }

  const meta = wahaMetaSchema.safeParse(row.meta)
  if (!meta.success) {
    return err({ kind: 'not_connected', detail: 'integration has no usable meta.session' })
  }

  return ok({ workspaceId, session: meta.data.session })
}

/**
 * Every workspace that has registered this WAHA session.
 *
 * THE ONE QUERY IN THIS MODULE THAT DOES NOT FILTER `workspace_id`, because it is
 * the query that establishes it — the same role `campaigns` plays for the n8n lead
 * webhook. It selects one column, `workspace_id`, and reads no tenant data
 * whatsoever; the caller passes what it returns to `resolveSessionWorkspace`, which
 * refuses to pick when the answer is not exactly one.
 *
 * Returns a list, not a row, on purpose. Migration 0018 makes more than one
 * impossible, and the caller still has to handle it: an inbound handler that
 * silently took the first match would attribute one tenant's conversation to
 * another the day that index was dropped.
 */
export async function findWorkspacesForSession(session: string): Promise<readonly string[]> {
  const rows = await db
    .select({ workspaceId: schema.integrations.workspaceId })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.provider, 'whatsapp'),
        eq(schema.integrations.status, 'connected'),
        sql`${schema.integrations.meta}->>'session' = ${session}`,
      ),
    )

  return rows.map((row) => row.workspaceId)
}

// -----------------------------------------------------------------------------
// The configured transport
// -----------------------------------------------------------------------------

export type TransportConfigError = {
  readonly kind: 'transport_not_configured'
  readonly missing: readonly string[]
}

/**
 * The WAHA transport built from the environment, or the list of variables that are
 * missing.
 *
 * A `Result` rather than a throw: "WhatsApp is not set up on this machine" is an
 * ordinary answer for a development box with no bridge running, and it must reach
 * the caller as a reason it can print, not as a crash. The variables are optional in
 * `env.ts` for the same reason — they are required by this module, not by boot.
 */
export function wahaTransportFromEnv(): Result<WhatsAppTransport, TransportConfigError> {
  const env = serverEnv()
  const missing: string[] = []
  if (env.WAHA_BASE_URL === undefined) missing.push('WAHA_BASE_URL')
  if (env.WAHA_API_KEY === undefined) missing.push('WAHA_API_KEY')

  if (env.WAHA_BASE_URL === undefined || env.WAHA_API_KEY === undefined) {
    return err({ kind: 'transport_not_configured', missing })
  }

  return ok(createWahaTransport({ baseUrl: env.WAHA_BASE_URL, apiKey: env.WAHA_API_KEY }))
}
