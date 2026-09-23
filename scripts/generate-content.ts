/**
 * Drafts one first-touch email for every qualified lead in a workspace that does
 * not have an outbound message yet (docs/SPEC.md §5, Module 5).
 *
 *   pnpm generate:content --workspace maju-bersama --limit 3
 *   pnpm generate:content --workspace maju-bersama --lead <uuid> --regenerate
 *
 * A command rather than a button, for the same reason `pnpm score:leads` is one:
 * a model call takes 5-25 seconds, so a dozen leads is minutes. The queue that
 * turns this into a background job is a later slice; this does not pretend to be
 * one.
 *
 * Nothing here sends anything. Every row it writes lands at `pending_approval` or
 * `needs_input`, both of which `send-guard.ts` refuses.
 *
 * Sequential, never parallel — it keeps the free-tier quota happy and keeps the
 * output readable as it lands.
 *
 * `--conditions=react-server` in the package.json script is load-bearing: the
 * modules below import `server-only`, whose default export throws outside a server
 * runtime. The condition resolves it to the package's own empty module.
 */

import { config } from 'dotenv'
import postgres from 'postgres'

config({ path: '.env.local', quiet: true })

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** Why a lead produced no draft, in the words the summary prints. */
const SKIP_LABELS: Record<string, string> = {
  no_contact_email: 'no contact email',
  already_drafted: 'already has an outbound message',
  duplicate_draft: 'a draft with this idempotency key already exists',
  not_qualified: 'not qualified',
  lead_not_found: 'lead not found',
}

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const slug = flag('workspace')
  if (slug === undefined) {
    console.error(
      'Usage: pnpm generate:content --workspace <slug> [--lead <id>] [--limit N] [--regenerate]',
    )
    process.exitCode = 1
    return
  }

  const leadFilter = flag('lead')
  const regenerate = has('regenerate')
  const limitFlag = Number(flag('limit') ?? '')
  const limit = Number.isInteger(limitFlag) && limitFlag > 0 ? limitFlag : null

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} })

  try {
    const [workspace] = await sql<{ id: string; name: string }[]>`
      select id, name from workspaces where slug = ${slug}`

    if (workspace === undefined) {
      console.error(`No workspace with slug "${slug}".`)
      process.exitCode = 1
      return
    }

    const [docs] = await sql<{ n: number }[]>`
      select count(*)::int as n from knowledge_docs
      where workspace_id = ${workspace.id} and is_active = true and content is not null`

    if (docs === undefined || docs.n === 0) {
      console.log('WARNING: this workspace has no active knowledge_docs.')
      console.log('  Nothing grounds a price, a package or a delivery time, so every draft')
      console.log('  that needs one will come back needs_input. Add them under Pengetahuan.')
      console.log('')
    }

    // Eligibility is the lib's decision, not this query's — a lead with no contact
    // email is selected here on purpose so it is reported rather than dropped.
    const leads = await sql<{ id: string; company: string | null }[]>`
      select l.id, c.name as company
      from leads l
      left join companies c on c.id = l.company_id
      where l.workspace_id = ${workspace.id}
        and l.status = 'qualified'
        ${leadFilter === undefined ? sql`` : sql`and l.id = ${leadFilter}`}
        ${
          regenerate
            ? sql``
            : sql`and not exists (
                select 1 from messages m
                where m.lead_id = l.id and m.workspace_id = l.workspace_id
                  and m.direction = 'out')`
        }
      order by l.score desc nulls last, l.created_at
      ${limit === null ? sql`` : sql`limit ${limit}`}`

    if (leads.length === 0) {
      console.log(
        regenerate
          ? `No qualified leads in ${slug}.`
          : `No qualified leads in ${slug} without an outbound message. Use --regenerate to draft again.`,
      )
      return
    }

    console.log(`Drafting for ${leads.length} qualified lead(s) in ${workspace.name} (${slug})`)
    console.log('')

    const { generateDraft } = await import('../src/lib/outreach/draft')

    let drafted = 0
    let needsInput = 0
    let failed = 0
    let totalCost = 0
    let totalLatency = 0
    const skipped = new Map<string, number>()

    for (const lead of leads) {
      const label = (lead.company ?? lead.id).slice(0, 34).padEnd(34)
      const result = await generateDraft({
        workspaceId: workspace.id,
        leadId: lead.id,
        regenerate,
      })

      if (!result.ok) {
        if (result.error.kind === 'model_failed') {
          failed += 1
          console.log(
            `  ${label} FAILED  ${result.error.error.kind}: ${result.error.error.message}`,
          )
          continue
        }
        const reason = SKIP_LABELS[result.error.kind] ?? result.error.kind
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
        console.log(`  ${label} SKIP    ${reason}`)
        continue
      }

      drafted += 1
      if (result.value.status === 'needs_input') needsInput += 1
      totalCost += result.value.costUsd
      totalLatency += result.value.latencyMs

      const gaps =
        result.value.missingInfo.length === 0
          ? ''
          : ` (${result.value.missingInfo.length} gap${result.value.missingInfo.length === 1 ? '' : 's'})`
      console.log(
        `  ${label} ${result.value.status.padEnd(16)} ` +
          `${String(result.value.latencyMs).padStart(6)}ms${gaps}`,
      )
    }

    console.log('')
    console.log(
      `Drafted ${drafted} (${drafted - needsInput} pending_approval, ${needsInput} needs_input), ` +
        `skipped ${[...skipped.values()].reduce((sum, n) => sum + n, 0)}, failed ${failed}.`,
    )
    for (const [reason, count] of skipped) {
      console.log(`  skipped: ${reason.padEnd(32)} ${count}`)
    }
    if (drafted > 0) {
      console.log(
        `  total cost     $${totalCost.toFixed(6)} (paid-tier rate; free tier bills nothing)`,
      )
      console.log(`  avg cost/draft $${(totalCost / drafted).toFixed(6)}`)
      console.log(`  avg latency    ${Math.round(totalLatency / drafted)}ms`)
    }
    console.log('')
    console.log('Nothing was sent. Review the queue under Persetujuan.')
  } finally {
    await sql.end()
    await globalThis.__soraPostgresClient?.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
