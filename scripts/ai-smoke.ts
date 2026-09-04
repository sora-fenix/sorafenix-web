/**
 * One real call through `runAgent`, printed with the `ai_runs` row it wrote.
 *
 *   pnpm ai:smoke
 *   pnpm ai:smoke --workspace data-riil
 *
 * The integration suite proves the retry, escalation and audit behaviour with a
 * scripted provider. Three things it cannot prove are exactly the three that only
 * a real provider can answer: that the model id in `lib/ai/models.ts` exists, that
 * the provider package is wired correctly, and that the SDK's token fields are
 * being read under the right names. This script is the check for those, and it
 * costs nothing on the Google free tier.
 *
 * `--conditions=react-server` in the package.json script is load-bearing:
 * `lib/ai/agent.ts` imports `server-only`, whose default export throws outside a
 * server runtime. The condition resolves it to the package's own empty module —
 * the same boundary the integration suite steps over deliberately (decision 25).
 */

import { config } from 'dotenv'
import postgres from 'postgres'
import { z } from 'zod'

config({ path: '.env.local', quiet: true })

/** Grounded in the text it is given, so a wrong answer means a wrong wiring. */
const schema = z.object({
  sentiment: z.enum(['positif', 'netral', 'negatif']),
  confidence: z.number().min(0).max(1),
})

const REVIEW = 'Barang sampai cepat dan kucing saya suka. Pelayanannya ramah sekali.'

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

  if (env.GOOGLE_GENERATIVE_AI_API_KEY === undefined && env.OPENAI_API_KEY === undefined) {
    console.error(
      'No model key is set.\n\n' +
        '  GOOGLE_GENERATIVE_AI_API_KEY — free tier, no card: https://aistudio.google.com/apikey\n' +
        '  OPENAI_API_KEY              — paid\n\n' +
        'Put one in .env.local and run this again.',
    )
    process.exitCode = 1
    return
  }

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} })

  try {
    const slug = flag('workspace')
    const rows = slug === undefined
      ? await sql<{ id: string; slug: string }[]>`
          select id, slug from workspaces order by created_at limit 1`
      : await sql<{ id: string; slug: string }[]>`
          select id, slug from workspaces where slug = ${slug}`

    const workspace = rows[0]
    if (workspace === undefined) {
      console.error(
        slug === undefined
          ? 'No workspace exists. Run `pnpm db:seed` or `pnpm workspace:create "Data Riil"` first.'
          : `No workspace with slug "${slug}".`,
      )
      process.exitCode = 1
      return
    }

    const { runAgent } = await import('../src/lib/ai/agent')

    console.log(`workspace  ${workspace.slug}`)
    console.log(`review     ${REVIEW}`)
    console.log('')

    const result = await runAgent({
      workspaceId: workspace.id,
      agent: 'classify_reply',
      system:
        'Kamu mengklasifikasi sentimen ulasan pelanggan. Jawab hanya dari teks yang diberikan.',
      prompt: `Ulasan: "${REVIEW}"`,
      schema,
    })

    if (!result.ok) {
      console.error(`FAILED  ${result.error.kind}`)
      console.error(`        ${result.error.message}`)
      for (const attempt of result.error.attempts) {
        console.error(`        attempt on ${attempt.model}: ${attempt.error ?? 'unknown'}`)
      }
      process.exitCode = 1
      return
    }

    console.log('OK')
    console.log(`  model      ${result.value.model}`)
    console.log(`  answer     ${JSON.stringify(result.value.value)}`)
    console.log(`  tokens     in ${result.value.tokensIn ?? '?'} / out ${result.value.tokensOut ?? '?'}`)
    console.log(`  cost       $${result.value.costUsd.toFixed(6)} (paid-tier rate; free tier bills nothing)`)
    console.log(`  latency    ${result.value.latencyMs}ms`)
    console.log(`  attempts   ${result.value.attempts.length}`)

    const [audit] = await sql<
      {
        agent: string
        model: string
        tokens_in: number | null
        tokens_out: number | null
        cost_usd: string | null
        latency_ms: number | null
        ok: boolean
      }[]
    >`select agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok
      from ai_runs where workspace_id = ${workspace.id}
      order by created_at desc limit 1`

    console.log('')
    console.log('ai_runs row written:')
    console.log(audit === undefined ? '  (none — the audit write failed, see the log above)' : audit)

    // A token count of zero or null means the SDK's usage fields moved and
    // lib/ai/agent.ts is reading the wrong names. Cost would be silently zero.
    if (result.value.tokensIn === null || result.value.tokensOut === null) {
      console.error('')
      console.error('WARNING: the provider reported no token usage. Check the usage field')
      console.error('         names in lib/ai/agent.ts against the installed AI SDK.')
      process.exitCode = 1
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
