/**
 * What the week of scraping actually produced.
 *
 *   pnpm leads:stats --workspace data-riil
 *   pnpm leads:stats --workspace data-riil --days 14
 *
 * The question this answers is commercial, not technical: how many distinct
 * businesses can Serper reach, and is it still finding new ones. Everything here
 * is a read — it never writes, so it is safe to run mid-sweep.
 *
 * Two numbers per day, and the second is the interesting one:
 *   new     — leads that did not exist before (`leads.created_at`)
 *   merged  — businesses Serper returned that dedupe recognised
 *             (`activities.type = 'lead_duplicate_merged'`)
 * `new` falling while `merged` climbs is saturation: the ground is covered, and
 * widening KEYWORDS/KOTA in the n8n Search Plan is what buys more, not more days.
 *
 * Days are bucketed in Asia/Jakarta, matching GENERIC_TIMEZONE in
 * docker-compose.n8n.yml, so a run at 08:00 local lands on the day it ran.
 *
 * No `server-only` import here, so unlike `pnpm score:leads` this needs no
 * `--conditions=react-server`.
 */

import { config } from 'dotenv'
import postgres from 'postgres'

config({ path: '.env.local', quiet: true })

const TZ = 'Asia/Jakarta'
const DEFAULT_DAYS = 7

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return ''
  return '█'.repeat(Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)))
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '  0%'
  return `${String(Math.round((part / whole) * 100)).padStart(3)}%`
}

function section(title: string): void {
  console.log('')
  console.log(title)
  console.log('─'.repeat(title.length))
}

type DayRow = {
  day: string
  created: number
  merged: number
  rejected: number
}

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const slug = flag('workspace')
  if (slug === undefined) {
    console.error('Usage: pnpm leads:stats --workspace <slug> [--days N]')
    process.exitCode = 1
    return
  }

  const daysFlag = Number(flag('days') ?? '')
  const days = Number.isInteger(daysFlag) && daysFlag > 0 ? daysFlag : DEFAULT_DAYS

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} })

  try {
    const [workspace] = await sql<{ id: string; name: string }[]>`
      select id, name from workspaces where slug = ${slug}`

    if (workspace === undefined) {
      console.error(`No workspace with slug "${slug}".`)
      process.exitCode = 1
      return
    }

    const id = workspace.id

    // -------------------------------------------------------------------------
    // Totals
    // -------------------------------------------------------------------------

    const [totals] = await sql<
      { companies: number; contacts: number; leads: number; scored: number }[]
    >`
      select
        (select count(*)::int from companies where workspace_id = ${id}) as companies,
        (select count(*)::int from contacts  where workspace_id = ${id}) as contacts,
        (select count(*)::int from leads     where workspace_id = ${id}) as leads,
        (select count(*)::int from leads     where workspace_id = ${id}
           and score is not null) as scored`

    console.log('')
    console.log(`SORA lead intake — ${workspace.name} (${slug})`)
    console.log(`Window: last ${days} day(s), bucketed in ${TZ}`)

    section('Totals')
    console.log(`  companies       ${String(totals?.companies ?? 0).padStart(6)}`)
    console.log(`  contacts        ${String(totals?.contacts ?? 0).padStart(6)}`)
    console.log(`  leads           ${String(totals?.leads ?? 0).padStart(6)}`)
    console.log(`  leads scored    ${String(totals?.scored ?? 0).padStart(6)}`)

    // -------------------------------------------------------------------------
    // Per day
    // -------------------------------------------------------------------------

    // generate_series, not `group by`, so a day the sweep did not run shows as a
    // zero row rather than vanishing. A missing day is a finding — the laptop was
    // asleep, or the workflow was not Active — and it must not be silently absent.
    const daily = await sql<DayRow[]>`
      with span as (
        select generate_series(
          (now() at time zone ${TZ})::date - ${days - 1}::int,
          (now() at time zone ${TZ})::date,
          interval '1 day'
        )::date as day
      ),
      created as (
        select (created_at at time zone ${TZ})::date as day, count(*)::int as n
        from leads where workspace_id = ${id} group by 1
      ),
      merged as (
        select (created_at at time zone ${TZ})::date as day, count(*)::int as n
        from activities
        where workspace_id = ${id} and type = 'lead_duplicate_merged' group by 1
      ),
      rejected as (
        select (created_at at time zone ${TZ})::date as day,
               coalesce(sum(jsonb_array_length(payload -> 'rejected')), 0)::int as n
        from webhook_events
        where workspace_id = ${id}
          and jsonb_typeof(payload -> 'rejected') = 'array'
        group by 1
      )
      select
        to_char(span.day, 'YYYY-MM-DD Dy') as day,
        coalesce(created.n, 0)  as created,
        coalesce(merged.n, 0)   as merged,
        coalesce(rejected.n, 0) as rejected
      from span
      left join created  on created.day  = span.day
      left join merged   on merged.day   = span.day
      left join rejected on rejected.day = span.day
      order by span.day`

    const maxFound = Math.max(...daily.map((r) => r.created + r.merged), 1)
    let running = 0

    section('Per day')
    console.log('  day                new   merged    found   cumulative')
    for (const row of daily) {
      const found = row.created + row.merged
      running += row.created
      const idle = found === 0 && row.rejected === 0 ? '  (no run)' : ''
      console.log(
        `  ${row.day.padEnd(16)}${String(row.created).padStart(5)}` +
          `${String(row.merged).padStart(9)}${String(found).padStart(9)}` +
          `${String(running).padStart(13)}  ${bar(found, maxFound)}${idle}`,
      )
    }

    const windowNew = daily.reduce((sum, r) => sum + r.created, 0)
    const windowFound = daily.reduce((sum, r) => sum + r.created + r.merged, 0)
    console.log('')
    console.log(
      `  ${windowNew} new from ${windowFound} contactable results ` +
        `(${pct(windowNew, windowFound).trim()} of what Serper returned was not already stored)`,
    )

    // -------------------------------------------------------------------------
    // How duplicates were caught
    // -------------------------------------------------------------------------

    // A spike on `domain` is the one to watch: several branches of one chain share
    // a website, and `byDomain` runs before every other strategy, so a chain can
    // collapse into a single company. See docs/PROGRESS.md.
    const strategies = await sql<{ strategy: string | null; n: number }[]>`
      select payload ->> 'strategy' as strategy, count(*)::int as n
      from activities
      where workspace_id = ${id}
        and type = 'lead_duplicate_merged'
        and created_at >= now() - make_interval(days => ${days})
      group by 1
      order by n desc`

    section('Duplicates by dedupe strategy')
    if (strategies.length === 0) {
      console.log('  none in this window')
    } else {
      for (const row of strategies) {
        console.log(`  ${(row.strategy ?? '(unrecorded)').padEnd(18)}${String(row.n).padStart(6)}`)
      }
    }

    // -------------------------------------------------------------------------
    // Reachability — which channel this segment actually has
    // -------------------------------------------------------------------------

    const [reach] = await sql<
      { total: number; phone: number; whatsapp: number; email: number; website: number }[]
    >`
      select
        count(*)::int as total,
        count(*) filter (where ct.phone     is not null)::int as phone,
        count(*) filter (where ct.whatsapp  is not null)::int as whatsapp,
        count(*) filter (where ct.email     is not null)::int as email,
        count(*) filter (where co.website   is not null)::int as website
      from companies co
      left join contacts ct
        on ct.company_id = co.id and ct.workspace_id = co.workspace_id
      where co.workspace_id = ${id}`

    section('Reachability (all companies)')
    const total = reach?.total ?? 0
    for (const [label, value] of [
      ['phone', reach?.phone ?? 0],
      ['whatsapp', reach?.whatsapp ?? 0],
      ['email', reach?.email ?? 0],
      ['website', reach?.website ?? 0],
    ] as const) {
      console.log(
        `  ${label.padEnd(12)}${String(value).padStart(6)}  ${pct(value, total)}  ${bar(value, total, 20)}`,
      )
    }

    // -------------------------------------------------------------------------
    // Where and what
    // -------------------------------------------------------------------------

    const cities = await sql<{ label: string; n: number }[]>`
      select coalesce(nullif(trim(city), ''), '(tidak diketahui)') as label, count(*)::int as n
      from companies where workspace_id = ${id}
      group by 1 order by n desc, label limit 15`

    section('Companies per city')
    for (const row of cities) {
      console.log(`  ${row.label.padEnd(26)}${String(row.n).padStart(6)}`)
    }

    const categories = await sql<{ label: string; n: number }[]>`
      select coalesce(nullif(trim(industry), ''), '(tidak diketahui)') as label, count(*)::int as n
      from companies where workspace_id = ${id}
      group by 1 order by n desc, label limit 15`

    section('Companies per category')
    for (const row of categories) {
      console.log(`  ${row.label.padEnd(40)}${String(row.n).padStart(6)}`)
    }

    console.log('')
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
