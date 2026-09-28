import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CSV_BOM } from '@/lib/export/csv'
import { type CsvUploadResult, importLeadsFromCsv } from '@/lib/leads/csv-upload'

import { openDatabase } from './helpers'

/**
 * The CSV upload, against a real database.
 *
 * Driven through `importLeadsFromCsv` rather than through the server action: the
 * action's own job is authentication and Bahasa Indonesia copy, and neither needs
 * Postgres to be true. What needs Postgres is that this path lands in the same
 * tables, with the same dedupe and the same audit rows, as the n8n webhook —
 * because it deliberately reuses `ingestLeads` and a second insert path appearing
 * here would be the failure this suite exists to catch.
 *
 * Its own workspaces, like ingest.test.ts: seed.test.ts rebuilds `maju-bersama`.
 */

const SLUG = 'csv-upload-test'

let sql: postgres.Sql
let workspaceId: string
let campaignId: string
let otherWorkspaceId: string
let otherCampaignId: string

const HEADER =
  'Nama Usaha;Kategori Usaha;Alamat;Kota;Rating;Jumlah Review;Website;Email;Telepon;WhatsApp;Sumber'

const PET_SHOP =
  'Pet Shop Surabaya;Toko hewan;Jl. Raya Darmo No. 12;Surabaya;"4,8";137;' +
  'https://petshopsby.com;info@petshopsby.com;="+628123456789";="+628123456789";' +
  'https://maps.google.com/?cid=123'

const GROOMING =
  'CV Grooming Ceria;;;Surabaya;;;https://groomingceria.co.id;halo@groomingceria.co.id;;;'

const KLINIK = 'Klinik Hewan Sejahtera;;;Surabaya;;;;;="+6281211112222";;'

/** A file exactly as Excel saves it: BOM, semicolons, CRLF, trailing newline. */
function file(...lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(CSV_BOM + [HEADER, ...lines].join('\r\n') + '\r\n')
}

async function upload(
  bytes: Uint8Array,
  into: { workspaceId: string; campaignId: string } = { workspaceId, campaignId },
): Promise<CsvUploadResult> {
  const result = await importLeadsFromCsv({ ...into, bytes })
  if (!result.ok) throw new Error(`upload failed: ${result.error}`)
  return result.value
}

async function countIn(table: string, id: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql(table)} where workspace_id = ${id}`
  return rows[0]?.n ?? -1
}

beforeAll(async () => {
  sql = openDatabase()
})

afterAll(async () => {
  await sql`delete from workspaces where slug like ${`${SLUG}%`}`
  await sql.end()
  // lib/db/drizzle.ts caches its pool on globalThis outside production; without
  // closing it the Vitest process would not exit.
  await globalThis.__soraPostgresClient?.end()
})

beforeEach(async () => {
  await sql`delete from workspaces where slug like ${`${SLUG}%`}`

  const created = await sql<{ id: string; slug: string }[]>`
    insert into workspaces (name, slug)
    values ('CSV Upload Test', ${SLUG}), ('CSV Upload Other', ${`${SLUG}-b`})
    returning id, slug`

  const main = created.find((row) => row.slug === SLUG)
  const other = created.find((row) => row.slug === `${SLUG}-b`)
  if (main === undefined || other === undefined) throw new Error('workspace fixture failed')
  workspaceId = main.id
  otherWorkspaceId = other.id

  const campaigns = await sql<{ id: string; workspace_id: string }[]>`
    insert into campaigns (workspace_id, name)
    values (${workspaceId}, 'Pet Shop Surabaya'), (${otherWorkspaceId}, 'Kampanye Lain')
    returning id, workspace_id`

  const mainCampaign = campaigns.find((row) => row.workspace_id === workspaceId)
  const otherCampaign = campaigns.find((row) => row.workspace_id === otherWorkspaceId)
  if (mainCampaign === undefined || otherCampaign === undefined) {
    throw new Error('campaign fixture failed')
  }
  campaignId = mainCampaign.id
  otherCampaignId = otherCampaign.id
})

// -----------------------------------------------------------------------------

describe('CSV upload — a valid file', () => {
  it('inserts a company, a contact and a lead per row', async () => {
    const result = await upload(file(PET_SHOP, GROOMING, KLINIK))

    expect(result).toEqual({ accepted: 3, inserted: 3, duplicates: 0, rejected: [] })
    expect(await countIn('companies', workspaceId)).toBe(3)
    expect(await countIn('contacts', workspaceId)).toBe(3)
    expect(await countIn('leads', workspaceId)).toBe(3)

    const [company] = await sql<
      {
        domain: string | null
        address: string | null
        rating: string | null
        review_count: number | null
        source: string | null
        source_url: string | null
      }[]
    >`
      select domain, address, rating, review_count, source, source_url
      from companies
      where workspace_id = ${workspaceId} and name = 'Pet Shop Surabaya'`
    expect(company?.domain).toBe('petshopsby.com')
    expect(company?.address).toBe('Jl. Raya Darmo No. 12')
    // The decimal comma the exporter writes survives the round trip as a number.
    expect(company?.rating).toBe('4.8')
    expect(company?.review_count).toBe(137)
    expect(company?.source).toBe('csv')
    expect(company?.source_url).toBe('https://maps.google.com/?cid=123')

    // The `="+62…"` cells are read back as numbers, not as the formula text.
    const phones = await sql<{ phone: string | null }[]>`
      select phone from contacts where workspace_id = ${workspaceId} order by phone nulls last`
    expect(phones.map((row) => row.phone)).toEqual([
      '+6281211112222',
      '+628123456789',
      null,
    ])

    // Rule 10: the same audit row the webhook path writes, with the same actor.
    const [activities] = await sql<{ n: number }[]>`
      select count(*)::int as n from activities
      where workspace_id = ${workspaceId}
        and type = 'lead_created' and actor = 'system' and channel = 'csv'`
    expect(activities?.n).toBe(3)
  })

  it('refuses a campaign that belongs to another workspace', async () => {
    const result = await importLeadsFromCsv({
      workspaceId,
      campaignId: otherCampaignId,
      bytes: file(PET_SHOP),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('campaign_not_found')
    expect(await countIn('companies', workspaceId)).toBe(0)
    expect(await countIn('companies', otherWorkspaceId)).toBe(0)
  })

  it('writes into the workspace it was given and no other', async () => {
    await upload(file(PET_SHOP, GROOMING, KLINIK))

    expect(await countIn('companies', workspaceId)).toBe(3)
    expect(await countIn('companies', otherWorkspaceId)).toBe(0)
    expect(await countIn('contacts', otherWorkspaceId)).toBe(0)
    expect(await countIn('leads', otherWorkspaceId)).toBe(0)
    expect(await countIn('activities', otherWorkspaceId)).toBe(0)

    // The same file into the other workspace is a fresh set of rows there, not a
    // duplicate of this one: dedupe is per tenant.
    const second = await upload(file(PET_SHOP), {
      workspaceId: otherWorkspaceId,
      campaignId: otherCampaignId,
    })
    expect(second.inserted).toBe(1)
    expect(await countIn('companies', workspaceId)).toBe(3)
  })
})

describe('CSV upload — uploading the same file again', () => {
  it('inserts nothing the second time', async () => {
    const first = await upload(file(PET_SHOP, GROOMING, KLINIK))
    expect(first.inserted).toBe(3)

    const second = await upload(file(PET_SHOP, GROOMING, KLINIK))
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(3)

    expect(await countIn('companies', workspaceId)).toBe(3)
    expect(await countIn('leads', workspaceId)).toBe(3)
  })

  it('fills the fields that were blank and leaves the ones that were not', async () => {
    // First pass: name and phone only.
    await upload(file('Pet Shop Surabaya;;;;;;;;="+628123456789";;'))

    // A human then corrected the city by hand. A re-upload must not undo that.
    await sql`update companies set city = 'Kota Surabaya' where workspace_id = ${workspaceId}`

    const second = await upload(file(PET_SHOP))
    expect(second.duplicates).toBe(1)
    expect(await countIn('companies', workspaceId)).toBe(1)

    const [company] = await sql<
      { domain: string | null; city: string | null; address: string | null }[]
    >`select domain, city, address from companies where workspace_id = ${workspaceId}`
    expect(company?.domain).toBe('petshopsby.com')
    expect(company?.address).toBe('Jl. Raya Darmo No. 12')
    expect(company?.city).toBe('Kota Surabaya')

    const [contact] = await sql<{ email: string | null }[]>`
      select email from contacts where workspace_id = ${workspaceId}`
    expect(contact?.email).toBe('info@petshopsby.com')

    const [merged] = await sql<{ n: number }[]>`
      select count(*)::int as n from activities
      where workspace_id = ${workspaceId} and type = 'lead_duplicate_merged'`
    expect(merged?.n).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// The privacy promise
// -----------------------------------------------------------------------------

describe('CSV upload — what an upload is not allowed to leave behind', () => {
  // The rejected rows carry markers so a leak is visible rather than plausible.
  const NO_CONTACT = 'Rahasia Tanpa Kontak;;;Kota Rahasia;;;;;;;'
  const NO_NAME = ';;;Kota Rahasia;;;;;="+628777666555";;'

  it('reports a rejected row as a line number and a reason, and nothing else', async () => {
    const result = await upload(file(PET_SHOP, NO_CONTACT, NO_NAME, KLINIK))

    expect(result.inserted).toBe(2)
    expect(result.rejected).toEqual([
      { line: 3, reason: 'no_contact_channel' },
      { line: 4, reason: 'company_name_missing' },
    ])

    // Nothing from either rejected row reaches the caller. The report is the one
    // thing about a rejected row that travels, so it is the one thing to pin.
    expect(JSON.stringify(result)).not.toContain('Rahasia')
    expect(JSON.stringify(result)).not.toContain('628777666555')
  })

  it('stores no webhook_events row for an upload', async () => {
    await upload(file(PET_SHOP, NO_CONTACT, KLINIK))

    // `webhook_events.payload` is the whole batch. A copy of the contact data
    // living there would sit outside every deletion path that looks at
    // `companies` and `contacts` (UU PDP 27/2022, .claude/rules/outreach.md).
    expect(await countIn('webhook_events', workspaceId)).toBe(0)
  })

  it('writes nothing when a stray quote would merge three rows into one name', async () => {
    // The parser refuses the file, so nothing reaches `ingestLeads`. Before it
    // did, this input inserted ONE company whose name was all three lines — two
    // customers' phone numbers stored in `companies.name`, a column the Prospek
    // screen renders, the export re-emits, and the draft generator reads.
    const bytes = new TextEncoder().encode(
      `${CSV_BOM}Nama Usaha;Telepon\r\n` +
        '"Toko A;08123456789\r\n' +
        'Toko B;08123456788\r\n' +
        'Toko C;08123456787\r\n',
    )

    const result = await importLeadsFromCsv({ workspaceId, campaignId, bytes })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unterminated_quote')

    expect(await countIn('companies', workspaceId)).toBe(0)
    expect(await countIn('contacts', workspaceId)).toBe(0)
    expect(await countIn('leads', workspaceId)).toBe(0)
  })

  it('keeps the accepted row in companies.raw, where the webhook also puts it', async () => {
    await upload(file(PET_SHOP))

    const [company] = await sql<{ raw: { companyName?: unknown } | null }[]>`
      select raw from companies where workspace_id = ${workspaceId}`
    expect(company?.raw?.companyName).toBe('Pet Shop Surabaya')
  })
})
