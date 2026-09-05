/**
 * Records what a workspace sells, and prints the row.
 *
 *   pnpm product:create --workspace data-riil --name "Paket Grooming Bulanan" \
 *     --value-prop "Jadwal grooming rutin yang terisi otomatis tiap bulan" \
 *     --industries "Ritel,Jasa Hewan" --cities "Surabaya,Sidoarjo" --sizes "1-10,11-50"
 *
 * Two of the six scoring factors — kesesuaian industri and kebutuhan produk —
 * judge a lead *against what we sell*. With no product row they have nothing to
 * rest on, and docs/SPEC.md §4 requires an ungrounded factor to score 50 neutral.
 * So a workspace with no product scores every lead into a flat, useless middle.
 * This script is the shortest path out of that.
 *
 * Idempotent by (workspace, name): re-running updates the existing row instead of
 * creating a second product.
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

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

/** `--industries "Ritel, Jasa Hewan"` → `['Ritel', 'Jasa Hewan']`. */
function list(name: string): string[] | undefined {
  const raw = flag(name)
  if (raw === undefined) return undefined
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return items.length === 0 ? undefined : items
}

async function main(): Promise<void> {
  const { serverEnv } = await import('../src/lib/env')
  const env = serverEnv()

  const slug = flag('workspace')
  const name = flag('name')

  if (slug === undefined || name === undefined) {
    console.error(
      'Usage: pnpm product:create --workspace <slug> --name "<product name>"\n\n' +
        'Optional:\n' +
        '  --description "..."      what it is\n' +
        '  --value-prop  "..."      the one line a salesperson would say\n' +
        '  --industries  "A,B"      industries it sells into\n' +
        '  --cities      "A,B"      cities it sells into\n' +
        '  --sizes       "11-50"    employee bands, matching companies.size_band\n' +
        '  --pains       "A,B"      problems it solves\n',
    )
    process.exitCode = 1
    return
  }

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} })
  const db = drizzle(sql, { schema })

  try {
    const [workspace] = await db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, slug))
      .limit(1)

    if (workspace === undefined) {
      console.error(`No workspace with slug "${slug}".`)
      process.exitCode = 1
      return
    }

    // Only the keys that were actually supplied. An ICP full of empty arrays reads
    // to the model as "we sell to nobody", which is worse than saying nothing.
    const icpEntries: [string, string[]][] = []
    const industries = list('industries')
    const cities = list('cities')
    const sizes = list('sizes')
    const pains = list('pains')
    if (industries !== undefined) icpEntries.push(['industries', industries])
    if (cities !== undefined) icpEntries.push(['cities', cities])
    if (sizes !== undefined) icpEntries.push(['size_bands', sizes])
    if (pains !== undefined) icpEntries.push(['pain_points', pains])
    const icp = icpEntries.length === 0 ? null : Object.fromEntries(icpEntries)

    const values = {
      workspaceId: workspace.id,
      name,
      description: flag('description') ?? null,
      valueProp: flag('value-prop') ?? null,
      icp,
      updatedAt: new Date(),
    }

    const [existing] = await db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(
        and(
          eq(schema.products.workspaceId, workspace.id),
          eq(schema.products.name, name),
        ),
      )
      .limit(1)

    const [row] = existing === undefined
      ? await db.insert(schema.products).values(values).returning()
      : await db
          .update(schema.products)
          .set(values)
          .where(
            and(
              eq(schema.products.id, existing.id),
              eq(schema.products.workspaceId, workspace.id),
            ),
          )
          .returning()

    if (row === undefined) throw new Error('product write returned no row')

    console.log(existing === undefined ? 'Product created.' : 'Product updated.')
    console.log(`  workspace   ${workspace.name} (${slug})`)
    console.log(`  name        ${row.name}`)
    console.log(`  value prop  ${row.valueProp ?? '(kosong)'}`)
    console.log(`  icp         ${row.icp === null ? '(kosong)' : JSON.stringify(row.icp)}`)

    if (row.icp === null || row.valueProp === null) {
      console.log('')
      console.log('Note: kesesuaian industri and kebutuhan produk are scored against the')
      console.log('value prop and the ICP. Leaving them empty makes those two factors')
      console.log('score 50 (neutral) on every lead, by design.')
    }
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
