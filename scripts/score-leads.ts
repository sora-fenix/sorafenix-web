/**
 * Scores every unqualified lead in a workspace, one at a time.
 *
 *   pnpm score:leads --workspace maju-bersama --rescore
 *   pnpm score:leads --workspace data-riil --limit 5
 *
 * A command rather than a button on purpose: one model call takes 5-25 seconds
 * (measured 2026-09-04), so a dozen leads is minutes. That is fine for something
 * you run and walk away from, and unusable for a form someone is staring at. The
 * queue that turns this into a background job is slice 3c; this does not pretend
 * to be one.
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

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const slug = flag('workspace')
  if (slug === undefined) {
    console.error('Usage: pnpm score:leads --workspace <slug> [--rescore] [--limit N]')
    process.exitCode = 1
    return
  }

  const rescore = has('rescore')
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

    const [product] = await sql<{ name: string }[]>`
      select name from products where workspace_id = ${workspace.id} limit 1`

    if (product === undefined) {
      console.log('WARNING: this workspace has no product.')
      console.log('  Kesesuaian industri and kebutuhan produk will score 50 (neutral) on')
      console.log('  every lead, per SPEC §4. Run `pnpm product:create` first for scores')
      console.log('  that actually rank.')
      console.log('')
    }

    // Only leads still sitting at `new`. A lead a salesperson has already contacted
    // is not waiting on a score.
    const leads = await sql<{ id: string; company: string | null; score: number | null }[]>`
      select l.id, c.name as company, l.score
      from leads l
      left join companies c on c.id = l.company_id
      where l.workspace_id = ${workspace.id}
        and l.status = 'new'
        ${rescore ? sql`` : sql`and l.score is null`}
      order by l.created_at
      ${limit === null ? sql`` : sql`limit ${limit}`}`

    if (leads.length === 0) {
      console.log(
        rescore
          ? `No leads with status "new" in ${slug}.`
          : `No unscored leads with status "new" in ${slug}. Use --rescore to redo them.`,
      )
      return
    }

    console.log(`Scoring ${leads.length} lead(s) in ${workspace.name} (${slug})`)
    if (product !== undefined) console.log(`Against product: ${product.name}`)
    console.log('')

    const { scoreLead } = await import('../src/lib/scoring/score')

    let done = 0
    let failed = 0
    let totalCost = 0
    let totalLatency = 0

    for (const lead of leads) {
      const label = (lead.company ?? lead.id).slice(0, 34).padEnd(34)
      const result = await scoreLead({
        workspaceId: workspace.id,
        leadId: lead.id,
        rescore,
      })

      if (!result.ok) {
        failed += 1
        const detail =
          result.error.kind === 'model_failed'
            ? `${result.error.error.kind}: ${result.error.error.message}`
            : result.error.kind
        console.log(`  ${label} FAILED  ${detail}`)
        continue
      }

      done += 1
      totalCost += result.value.costUsd
      totalLatency += result.value.latencyMs

      const moved = result.value.statusChangedTo === null ? '' : ' → qualified'
      console.log(
        `  ${label} ${String(result.value.score).padStart(3)} ` +
          `${result.value.category.padEnd(4)} ` +
          `${String(result.value.latencyMs).padStart(6)}ms${moved}`,
      )
    }

    console.log('')
    console.log(`Scored ${done}, failed ${failed}.`)
    if (done > 0) {
      console.log(`  total cost    $${totalCost.toFixed(6)} (paid-tier rate; free tier bills nothing)`)
      console.log(`  avg cost/lead $${(totalCost / done).toFixed(6)}`)
      console.log(`  avg latency   ${Math.round(totalLatency / done)}ms`)
    }
  } finally {
    await sql.end()
    await globalThis.__soraPostgresClient?.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
