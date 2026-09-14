/**
 * Classifies leads from the signals the scrape already recorded — no model.
 *
 *   pnpm classify:leads --workspace data-riil --dry-run
 *   pnpm classify:leads --workspace data-riil
 *   pnpm classify:leads --workspace data-riil --reclassify --limit 50
 *
 * The deterministic sibling of `pnpm score:leads`. That one costs 5-37 seconds and
 * a model call per lead; this one is arithmetic over columns, so the whole of
 * `data-riil` finishes in one run and can be re-run whenever the rubric changes.
 *
 * `--dry-run` computes and prints the band distribution without writing a single
 * row — worth doing first on a workspace this size, because the sensible way to
 * judge a rubric is to look at how it splits the population, not at one lead.
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

function bar(count: number, total: number, width = 28): string {
  if (total === 0) return ''
  return '#'.repeat(Math.max(count === 0 ? 0 : 1, Math.round((count / total) * width)))
}

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const slug = flag('workspace')
  if (slug === undefined) {
    console.error(
      'Usage: pnpm classify:leads --workspace <slug> [--dry-run] [--reclassify] [--limit N]',
    )
    process.exitCode = 1
    return
  }

  const reclassify = has('reclassify')
  const dryRun = has('dry-run')
  const limitFlag = Number(flag('limit') ?? '')
  const limit = Number.isInteger(limitFlag) && limitFlag > 0 ? limitFlag : undefined

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} })

  try {
    const [workspace] = await sql<{ id: string; name: string }[]>`
      select id, name from workspaces where slug = ${slug}`

    if (workspace === undefined) {
      console.error(`No workspace with slug "${slug}".`)
      process.exitCode = 1
      return
    }

    // Coverage first. A rubric is only as good as the columns behind it, and a
    // backfill that did not run shows up here as a wall of neutral scores rather
    // than as an error.
    const [coverage] = await sql<
      { total: number; rated: number; reviewed: number; sited: number }[]
    >`
      select
        count(*)::int                                              as total,
        count(*) filter (where rating is not null)::int            as rated,
        count(*) filter (where review_count is not null)::int      as reviewed,
        count(*) filter (where domain is not null)::int            as sited
      from companies
      where workspace_id = ${workspace.id}`

    console.log(`Classifying leads in ${workspace.name} (${slug})`)
    if (coverage !== undefined) {
      console.log(
        `Signal coverage: ${coverage.rated}/${coverage.total} rated, ` +
          `${coverage.reviewed}/${coverage.total} with review counts, ` +
          `${coverage.sited}/${coverage.total} with a website`,
      )
    }
    if (dryRun) console.log('DRY RUN — nothing will be written.')
    console.log('')

    const { classifyLeads } = await import('../src/lib/scoring/classify')

    const started = Date.now()
    const result = await classifyLeads({
      workspaceId: workspace.id,
      reclassify,
      limit,
      dryRun,
    })
    const elapsed = Date.now() - started

    if (result.considered === 0) {
      console.log(
        reclassify
          ? `No leads to classify in ${slug}.`
          : `No unclassified leads in ${slug}. Use --reclassify to redo them.`,
      )
      return
    }

    // The ten strongest and the five weakest. Printing 1208 rows tells nobody
    // anything; the ends of the distribution are where a wrong rubric shows.
    const ranked = [...result.classified].sort((a, b) => b.score - a.score)

    console.log('Top 10:')
    for (const lead of ranked.slice(0, 10)) {
      console.log(
        `  ${String(lead.score).padStart(3)} ${lead.category.padEnd(4)} ` +
          `${lead.companyName.slice(0, 46)}`,
      )
    }
    console.log('')
    console.log('Bottom 5:')
    for (const lead of ranked.slice(-5)) {
      console.log(
        `  ${String(lead.score).padStart(3)} ${lead.category.padEnd(4)} ` +
          `${lead.companyName.slice(0, 46)}`,
      )
    }

    const total = result.considered
    console.log('')
    console.log(`Classified ${total} lead(s) in ${elapsed}ms:`)
    console.log(`  hot   ${String(result.hot).padStart(5)}  ${bar(result.hot, total)}`)
    console.log(`  warm  ${String(result.warm).padStart(5)}  ${bar(result.warm, total)}`)
    console.log(`  cold  ${String(result.cold).padStart(5)}  ${bar(result.cold, total)}`)
    console.log('')

    if (dryRun) {
      console.log('Nothing written. Drop --dry-run to commit these scores.')
    } else {
      console.log(`${result.qualified} lead(s) moved new → qualified (cold stays new).`)
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
