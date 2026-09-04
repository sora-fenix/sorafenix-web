import postgres from 'postgres'

/**
 * Shared plumbing for the integration suite.
 *
 * These tests connect as `postgres`, which carries BYPASSRLS. That is precisely
 * why every RLS assertion must first `SET LOCAL ROLE authenticated` — otherwise
 * the policies are never consulted and the test would pass just as happily
 * against a database with no security on it at all.
 */

export function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. Run `pnpm db:start`, then make sure .env.local points at it.',
    )
  }
  return url
}

export function openDatabase(): postgres.Sql {
  return postgres(connectionString(), { prepare: false, max: 4, onnotice: () => {} })
}

/**
 * Every table scoped to a workspace, and therefore every table that must carry
 * an RLS policy. Kept as a literal list on purpose: rls.test.ts cross-checks it
 * against the live catalogue, so a new table that is not listed here fails the
 * suite instead of quietly escaping the sweep.
 */
export const WORKSPACE_SCOPED_TABLES = [
  'activities',
  'ai_runs',
  'campaigns',
  'companies',
  'contacts',
  'integrations',
  'knowledge_docs',
  'leads',
  'memberships',
  'messages',
  'products',
  'sequence_runs',
  'suppressions',
  'webhook_events',
] as const

export type WorkspaceScopedTable = (typeof WORKSPACE_SCOPED_TABLES)[number]

export type Fixture = {
  workspaceId: string
  userId: string
  companyId: string
  contactId: string
  leadId: string
}

/**
 * Builds one complete workspace: an auth user, a membership, and exactly one row
 * in every workspace-scoped table. Inserted in dependency order and as the
 * privileged role, so this is fixture setup, not the thing under test.
 */
export async function createWorkspaceFixture(
  sql: postgres.Sql,
  tag: string,
): Promise<Fixture> {
  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values (${`RLS ${tag}`}, ${`rls-${tag}`})
    returning id`
  const [user] = await sql<{ id: string }[]>`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${`rls-${tag}@example.test`})
    returning id`

  if (ws === undefined || user === undefined) {
    throw new Error('fixture setup failed to return ids')
  }
  const workspaceId = ws.id
  const userId = user.id

  await sql`insert into memberships (workspace_id, user_id, role)
            values (${workspaceId}, ${userId}, 'owner')`

  const [company] = await sql<{ id: string }[]>`
    insert into companies (workspace_id, name, domain)
    values (${workspaceId}, ${`Company ${tag}`}, ${`rls-${tag}.example`})
    returning id`
  if (company === undefined) throw new Error('company fixture failed')

  const [contact] = await sql<{ id: string }[]>`
    insert into contacts (workspace_id, company_id, name, email)
    values (${workspaceId}, ${company.id}, ${`Contact ${tag}`}, ${`c-${tag}@example.test`})
    returning id`
  if (contact === undefined) throw new Error('contact fixture failed')

  const [product] = await sql<{ id: string }[]>`
    insert into products (workspace_id, name) values (${workspaceId}, ${`Product ${tag}`})
    returning id`
  if (product === undefined) throw new Error('product fixture failed')

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (workspace_id, name, product_id)
    values (${workspaceId}, ${`Campaign ${tag}`}, ${product.id})
    returning id`
  if (campaign === undefined) throw new Error('campaign fixture failed')

  const [lead] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, campaign_id, company_id, contact_id, score, category, status)
    values (${workspaceId}, ${campaign.id}, ${company.id}, ${contact.id}, 88, 'hot', 'qualified')
    returning id`
  if (lead === undefined) throw new Error('lead fixture failed')

  await sql`insert into activities (workspace_id, lead_id, type, actor)
            values (${workspaceId}, ${lead.id}, 'lead_created', 'system')`
  await sql`insert into messages (workspace_id, lead_id, channel, direction, status, subject)
            values (${workspaceId}, ${lead.id}, 'email', 'out', 'sent', ${`Subject ${tag}`})`
  await sql`insert into sequence_runs (workspace_id, lead_id, current_step, state)
            values (${workspaceId}, ${lead.id}, 1, 'active')`
  await sql`insert into knowledge_docs (workspace_id, type, title)
            values (${workspaceId}, 'faq', ${`Doc ${tag}`})`
  await sql`insert into integrations (workspace_id, provider, status)
            values (${workspaceId}, 'serper', 'connected')`
  await sql`insert into suppressions (workspace_id, kind, value)
            values (${workspaceId}, 'email', ${`stop-${tag}@example.test`})`
  await sql`insert into ai_runs (workspace_id, agent, model, ok)
            values (${workspaceId}, 'qualify', 'gemini-3.7-flash', true)`
  await sql`insert into webhook_events (workspace_id, provider, idempotency_key)
            values (${workspaceId}, 'n8n', ${`rls-${tag}-key`})`

  return {
    workspaceId,
    userId,
    companyId: company.id,
    contactId: contact.id,
    leadId: lead.id,
  }
}

/**
 * Runs `body` as the `authenticated` role with auth.uid() resolving to `userId`,
 * then restores the privileged role. This is how Supabase presents a logged-in
 * user to Postgres: auth.uid() reads request.jwt.claims->>'sub'.
 */
export async function asUser<T>(
  sql: postgres.Sql,
  userId: string,
  body: () => Promise<T>,
): Promise<T> {
  await sql.unsafe(`set local role authenticated`)
  await sql.unsafe(`set local request.jwt.claims = '${JSON.stringify({ sub: userId })}'`)
  try {
    return await body()
  } finally {
    await sql.unsafe(`reset role`)
    await sql.unsafe(`set local request.jwt.claims = ''`)
  }
}

/**
 * Runs a statement that is expected to be rejected by a policy, and returns the
 * error message.
 *
 * The savepoint matters: a failed statement aborts the whole transaction, and
 * without rolling back to a savepoint every later assertion in the file would
 * die with "current transaction is aborted" instead of running.
 */
export async function probeRejection(
  sql: postgres.Sql,
  userId: string,
  statement: string,
  params: readonly (string | number | null)[],
): Promise<string> {
  await sql.unsafe('savepoint rls_probe')
  let message = ''
  try {
    await sql.unsafe(`set local role authenticated`)
    await sql.unsafe(`set local request.jwt.claims = '${JSON.stringify({ sub: userId })}'`)
    await sql.unsafe(statement, [...params])
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  // Also reverts the SET LOCALs above, since they were made after the savepoint.
  await sql.unsafe('rollback to savepoint rls_probe')
  await sql.unsafe('reset role')
  return message
}
