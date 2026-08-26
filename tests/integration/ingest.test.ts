import { createHmac } from 'node:crypto'

import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST } from '@/app/api/webhooks/n8n/leads/route'

import { openDatabase } from './helpers'

/**
 * The acceptance test for SPEC §2, driven through the real route handler so the
 * signature check, the Zod boundary, idempotency and dedupe are all exercised
 * together rather than one mock at a time.
 *
 * Its own workspace, not the demo one: seed.test.ts rebuilds `maju-bersama`, and
 * a suite that writes into a workspace another suite deletes is a suite that
 * fails for reasons that have nothing to do with the code under test.
 */

const SLUG = 'ingest-test'

let sql: postgres.Sql
let workspaceId: string
let campaignId: string

type ResponseBody = {
  accepted: number
  inserted: number
  duplicates: number
  rejected: { index: number; reason: string }[]
  replayed: boolean
}

type Item = Record<string, unknown>

function sign(body: string): string {
  const secret = process.env.N8N_WEBHOOK_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('N8N_WEBHOOK_SECRET is not set; check .env.local')
  }
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

function request(body: unknown, signature?: string | null): Request {
  const raw = JSON.stringify(body)
  const headers = new Headers({ 'content-type': 'application/json' })
  const value = signature === undefined ? sign(raw) : signature
  if (value !== null) headers.set('x-sora-signature', value)

  return new Request('http://localhost:3000/api/webhooks/n8n/leads', {
    method: 'POST',
    headers,
    body: raw,
  })
}

function payload(items: Item[], idempotencyKey: string): Record<string, unknown> {
  return {
    campaign_id: campaignId,
    source: 'serper_places',
    idempotency_key: idempotencyKey,
    items,
  }
}

async function post(body: unknown, signature?: string | null): Promise<Response> {
  return POST(request(body, signature))
}

async function bodyOf(response: Response): Promise<ResponseBody> {
  const json: unknown = await response.json()
  if (typeof json !== 'object' || json === null) throw new Error('response is not an object')

  const record: Record<string, unknown> = { ...json }
  const { accepted, inserted, duplicates, rejected, replayed } = record
  if (
    typeof accepted !== 'number' ||
    typeof inserted !== 'number' ||
    typeof duplicates !== 'number' ||
    typeof replayed !== 'boolean' ||
    !Array.isArray(rejected)
  ) {
    throw new Error(`unexpected response shape: ${JSON.stringify(json)}`)
  }

  const parsedRejected = rejected.map((entry) => {
    const item: { index?: unknown; reason?: unknown } = entry
    if (typeof item.index !== 'number' || typeof item.reason !== 'string') {
      throw new Error('unexpected rejected entry')
    }
    return { index: item.index, reason: item.reason }
  })

  return { accepted, inserted, duplicates, rejected: parsedRejected, replayed }
}

async function countCompanies(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from companies where workspace_id = ${workspaceId}`
  return rows[0]?.n ?? -1
}

async function countLeads(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from leads where workspace_id = ${workspaceId}`
  return rows[0]?.n ?? -1
}

const PET_SHOP: Item = {
  company_name: 'Pet Shop Surabaya',
  website: 'https://petshopsby.com',
  address: 'Jl. Raya Darmo No. 12',
  city: 'Surabaya',
  phone: '+628123456789',
  email: 'info@petshopsby.com',
  category: 'Pet store',
  source_url: 'https://www.google.com/maps?cid=123',
}

const GROOMING: Item = {
  company_name: 'CV Grooming Ceria',
  website: 'https://groomingceria.co.id',
  city: 'Surabaya',
  phone: '031-8765432',
  email: 'halo@groomingceria.co.id',
}

const KLINIK: Item = {
  company_name: 'Klinik Hewan Sejahtera',
  city: 'Surabaya',
  phone: '0812-1111-2222',
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
  // A fresh workspace per test: dedupe assertions depend on exactly what is in
  // the table, and leftovers from a previous test would make them lie.
  await sql`delete from workspaces where slug like ${`${SLUG}%`}`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Ingest Test', ${SLUG}) returning id`
  if (ws === undefined) throw new Error('workspace fixture failed')
  workspaceId = ws.id

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (workspace_id, name) values (${workspaceId}, 'Pet Shop Surabaya')
    returning id`
  if (campaign === undefined) throw new Error('campaign fixture failed')
  campaignId = campaign.id
})

// -----------------------------------------------------------------------------

describe('POST /api/webhooks/n8n/leads — signature', () => {
  it('rejects a request with no signature', async () => {
    const response = await post(payload([PET_SHOP], 'run-nosig'), null)
    expect(response.status).toBe(401)
    expect(await countCompanies()).toBe(0)
  })

  it('rejects a signature computed with the wrong secret', async () => {
    const raw = JSON.stringify(payload([PET_SHOP], 'run-wrongsecret'))
    const forged = `sha256=${createHmac('sha256', 'not-the-secret').update(raw).digest('hex')}`

    const response = await post(payload([PET_SHOP], 'run-wrongsecret'), forged)
    expect(response.status).toBe(401)
    expect(await countCompanies()).toBe(0)
  })

  it('rejects a malformed signature header', async () => {
    const response = await post(payload([PET_SHOP], 'run-malformed'), 'sha256=zzzz')
    expect(response.status).toBe(401)
  })

  // The signature covers the exact bytes sent. Re-serialising changes them.
  it('rejects a body that was altered after signing', async () => {
    const original = JSON.stringify(payload([PET_SHOP], 'run-tamper'))
    const tampered = JSON.stringify(payload([PET_SHOP, GROOMING], 'run-tamper'))

    const response = await POST(
      new Request('http://localhost:3000/api/webhooks/n8n/leads', {
        method: 'POST',
        headers: { 'x-sora-signature': sign(original) },
        body: tampered,
      }),
    )
    expect(response.status).toBe(401)
    expect(await countCompanies()).toBe(0)
  })
})

describe('POST /api/webhooks/n8n/leads — validation', () => {
  it('rejects a payload that is not valid JSON', async () => {
    const raw = '{"campaign_id":'
    const response = await POST(
      new Request('http://localhost:3000/api/webhooks/n8n/leads', {
        method: 'POST',
        headers: { 'x-sora-signature': sign(raw) },
        body: raw,
      }),
    )
    expect(response.status).toBe(400)
  })

  it('rejects a payload missing required fields', async () => {
    const response = await post({ items: [] })
    expect(response.status).toBe(422)
  })

  it('rejects an unknown source', async () => {
    const response = await post({
      ...payload([PET_SHOP], 'run-badsource'),
      source: 'linkedin',
    })
    expect(response.status).toBe(422)
  })

  it('rejects an unknown campaign without writing anything', async () => {
    const response = await post({
      ...payload([PET_SHOP], 'run-nocampaign'),
      campaign_id: '00000000-0000-4000-8000-000000000000',
    })
    expect(response.status).toBe(404)
    expect(await countCompanies()).toBe(0)
  })
})

describe('POST /api/webhooks/n8n/leads — ingestion', () => {
  it('inserts a company, a contact and a lead per accepted item', async () => {
    const response = await post(payload([PET_SHOP, GROOMING, KLINIK], 'run-1'))
    expect(response.status).toBe(200)

    const body = await bodyOf(response)
    expect(body).toMatchObject({
      accepted: 3,
      inserted: 3,
      duplicates: 0,
      rejected: [],
      replayed: false,
    })

    expect(await countCompanies()).toBe(3)
    expect(await countLeads()).toBe(3)

    const [company] = await sql<
      { name: string; domain: string; name_normalized: string; dedupe_key: string }[]
    >`
      select name, domain, name_normalized, dedupe_key from companies
      where workspace_id = ${workspaceId} and name = 'Pet Shop Surabaya'`
    expect(company?.domain).toBe('petshopsby.com')
    expect(company?.name_normalized).toBe('pet shop surabaya')
    expect(company?.dedupe_key).toBe('domain:petshopsby.com')

    // Phones are stored canonical, whatever spelling arrived.
    const phones = await sql<{ phone: string }[]>`
      select phone from contacts where workspace_id = ${workspaceId} order by phone`
    expect(phones.map((p) => p.phone)).toEqual([
      '+62318765432',
      '+6281211112222',
      '+628123456789',
    ])

    // Rule 10: every new lead leaves an audit row.
    const [activities] = await sql<{ n: number }[]>`
      select count(*)::int as n from activities
      where workspace_id = ${workspaceId} and type = 'lead_created' and actor = 'system'`
    expect(activities?.n).toBe(3)
  })

  it('rejects items with no website, phone or email', async () => {
    const body = await bodyOf(
      await post(
        payload(
          [PET_SHOP, { company_name: 'Toko Tanpa Kontak', city: 'Surabaya' }, KLINIK],
          'run-reject',
        ),
      ),
    )

    expect(body.accepted).toBe(3)
    expect(body.inserted).toBe(2)
    expect(body.rejected).toEqual([{ index: 1, reason: 'no_contact_channel' }])
    expect(await countCompanies()).toBe(2)
  })

  it('rejects placeholder contact values that are not really contacts', async () => {
    const body = await bodyOf(
      await post(
        payload(
          [{ company_name: 'Toko Placeholder', city: 'Surabaya', phone: '-', email: 'n/a' }],
          'run-placeholder',
        ),
      ),
    )
    expect(body.rejected).toEqual([{ index: 0, reason: 'no_contact_channel' }])
  })
})

// -----------------------------------------------------------------------------
// The acceptance criterion
// -----------------------------------------------------------------------------

describe('POST /api/webhooks/n8n/leads — idempotency', () => {
  it('posting the same payload twice inserts 0 rows the second time', async () => {
    const body = payload([PET_SHOP, GROOMING, KLINIK], 'run_20260826_143000')

    const first = await bodyOf(await post(body))
    expect(first.inserted).toBe(3)
    expect(first.replayed).toBe(false)

    const companiesAfterFirst = await countCompanies()
    const leadsAfterFirst = await countLeads()

    const second = await bodyOf(await post(body))
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(3)
    expect(second.accepted).toBe(3)
    expect(second.replayed).toBe(true)

    expect(await countCompanies()).toBe(companiesAfterFirst)
    expect(await countLeads()).toBe(leadsAfterFirst)
  })

  it('records the idempotency key exactly once', async () => {
    const body = payload([PET_SHOP], 'run-once')
    await post(body)
    await post(body)
    await post(body)

    const [events] = await sql<{ n: number }[]>`
      select count(*)::int as n from webhook_events
      where workspace_id = ${workspaceId} and idempotency_key = 'run-once'`
    expect(events?.n).toBe(1)
  })

  it('marks a processed event with processed_at', async () => {
    await post(payload([PET_SHOP], 'run-processed'))
    const [event] = await sql<{ processed_at: Date | null }[]>`
      select processed_at from webhook_events
      where workspace_id = ${workspaceId} and idempotency_key = 'run-processed'`
    expect(event?.processed_at).not.toBeNull()
  })

  it('a genuinely new run still dedupes against what the previous run stored', async () => {
    await post(payload([PET_SHOP, GROOMING], 'run-a'))
    const body = await bodyOf(await post(payload([PET_SHOP, GROOMING, KLINIK], 'run-b')))

    // Different key, so this is not a replay — the two repeats are caught by
    // dedupe itself, which is the stronger guarantee.
    expect(body.replayed).toBe(false)
    expect(body.inserted).toBe(1)
    expect(body.duplicates).toBe(2)
    expect(await countCompanies()).toBe(3)
  })
})

// -----------------------------------------------------------------------------
// Dedupe strategies, against real rows
// -----------------------------------------------------------------------------

describe('POST /api/webhooks/n8n/leads — dedupe', () => {
  it('matches on domain however the URL is written', async () => {
    await post(payload([PET_SHOP], 'run-d1'))
    const body = await bodyOf(
      await post(
        payload(
          [{ ...PET_SHOP, website: 'http://WWW.PetShopSBY.com/kontak?utm=x' }],
          'run-d2',
        ),
      ),
    )

    expect(body.duplicates).toBe(1)
    expect(await countCompanies()).toBe(1)
  })

  it('matches on phone however the number is written', async () => {
    await post(payload([KLINIK], 'run-p1'))
    const body = await bodyOf(
      await post(
        payload(
          [{ company_name: 'Klinik Hewan Sejahtera 2', phone: '+62 812 1111 2222' }],
          'run-p2',
        ),
      ),
    )

    expect(body.duplicates).toBe(1)
    expect(await countCompanies()).toBe(1)
  })

  it('matches on email when domain and phone differ', async () => {
    await post(payload([PET_SHOP], 'run-e1'))
    const body = await bodyOf(
      await post(
        payload(
          [
            {
              company_name: 'Pet Shop SBY cabang',
              email: 'INFO@PetShopSBY.com',
              phone: '0899-0000-1111',
            },
          ],
          'run-e2',
        ),
      ),
    )

    expect(body.duplicates).toBe(1)
    expect(await countCompanies()).toBe(1)
  })

  it('sees through the legal form: "PT Bahagia Petcare" is "Bahagia Petcare"', async () => {
    await post(
      payload(
        [{ company_name: 'PT Bahagia Petcare', city: 'Surabaya', phone: '0812-3000-4000' }],
        'run-f1',
      ),
    )

    const body = await bodyOf(
      await post(
        payload(
          [{ company_name: 'Bahagia Petcare', city: 'Surabaya', email: 'a@bahagiapetcare.id' }],
          'run-f2',
        ),
      ),
    )

    expect(body.duplicates).toBe(1)
    expect(await countCompanies()).toBe(1)
  })

  // Trigram similarity is order-insensitive, so this is a genuinely different
  // string scoring 1.0 — the case an equality check would miss entirely.
  it('matches the same words in a different order', async () => {
    await post(
      payload(
        [{ company_name: 'Petcare Bahagia', city: 'Surabaya', phone: '0812-3100-4100' }],
        'run-f3',
      ),
    )

    const body = await bodyOf(
      await post(
        payload(
          [{ company_name: 'Bahagia Petcare', city: 'Surabaya', email: 'b@bahagiapetcare.id' }],
          'run-f4',
        ),
      ),
    )

    expect(body.duplicates).toBe(1)
    expect(await countCompanies()).toBe(1)
  })

  // Measured against this database: 'bahagia petcare sejahtera' vs
  // '…sejahtra' scores 0.821, under SPEC's 0.85. The threshold is therefore
  // doing real work here — if this test starts failing, someone loosened it.
  it('does not merge a one-letter typo, which falls under the 0.85 threshold', async () => {
    await post(
      payload(
        [
          {
            company_name: 'Bahagia Petcare Sejahtera',
            city: 'Surabaya',
            phone: '0812-3200-4200',
          },
        ],
        'run-f5',
      ),
    )

    const body = await bodyOf(
      await post(
        payload(
          [
            {
              company_name: 'Bahagia Petcare Sejahtra',
              city: 'Surabaya',
              email: 'c@bahagiapetcare.id',
            },
          ],
          'run-f6',
        ),
      ),
    )

    expect(body.inserted).toBe(1)
    expect(body.duplicates).toBe(0)
    expect(await countCompanies()).toBe(2)
  })

  it('does not merge a similar name in a different city', async () => {
    await post(payload([{ company_name: 'Toko Bahagia', city: 'Surabaya', phone: '0812-5000-6000' }], 'run-c1'))
    const body = await bodyOf(
      await post(
        payload([{ company_name: 'Toko Bahagia', city: 'Bandung', phone: '0812-7000-8000' }], 'run-c2'),
      ),
    )

    expect(body.inserted).toBe(1)
    expect(await countCompanies()).toBe(2)
  })

  it('fills blanks on a duplicate without overwriting what is already stored', async () => {
    await post(payload([{ company_name: 'Pet Shop Surabaya', phone: '+628123456789' }], 'run-m1'))

    const body = await bodyOf(
      await post(
        payload(
          [
            {
              company_name: 'Pet Shop Surabaya',
              phone: '+628123456789',
              website: 'https://petshopsby.com',
              city: 'Surabaya',
              email: 'info@petshopsby.com',
            },
          ],
          'run-m2',
        ),
      ),
    )
    expect(body.duplicates).toBe(1)

    const [company] = await sql<{ domain: string | null; city: string | null }[]>`
      select domain, city from companies where workspace_id = ${workspaceId}`
    expect(company?.domain).toBe('petshopsby.com')
    expect(company?.city).toBe('Surabaya')

    const [contact] = await sql<{ email: string | null }[]>`
      select email from contacts where workspace_id = ${workspaceId}`
    expect(contact?.email).toBe('info@petshopsby.com')

    const [merged] = await sql<{ n: number }[]>`
      select count(*)::int as n from activities
      where workspace_id = ${workspaceId} and type = 'lead_duplicate_merged'`
    expect(merged?.n).toBe(1)
  })

  it('collapses two identical items inside one payload', async () => {
    const body = await bodyOf(await post(payload([PET_SHOP, PET_SHOP], 'run-samebatch')))

    expect(body.inserted).toBe(1)
    expect(body.duplicates).toBe(1)
    expect(await countCompanies()).toBe(1)
  })
})
