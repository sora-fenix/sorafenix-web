import { createHmac } from 'node:crypto'

import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { POST } from '@/app/api/webhooks/n8n/plan/route'
import { fingerprintTarget, parseTarget } from '@/lib/scraping/target'

import { openDatabase } from './helpers'

/**
 * The plan endpoint (ADR 0001 §5), driven through the real route handler so the
 * signature, the Zod boundary, the transaction and the cursor write are exercised
 * together.
 *
 * THIS SUITE TOUCHES ROWS IT DOES NOT OWN, and that is the point: `context.ts`
 * reads every running campaign in the database, so a plan built here necessarily
 * plans whatever else is running locally — `data-riil` above all. Every cursor
 * row outside this suite's fixtures is snapshotted before the first test and
 * restored after the last, and the claim rows are keyed so they can be deleted by
 * prefix. A test that leaves a real tenant's sweep advanced is a test that costs
 * Serper credits.
 *
 * The plan date is deliberately far from any real one, so a crash between the
 * snapshot and the restore cannot make a real day look already planned.
 */

const SLUG = 'plan-test'
const PLAN_DATE = '2026-01-05'
const KEY_PREFIX = 'plan-test-'

let sql: postgres.Sql
let workspaceA: string
let workspaceB: string
let runningA: string
let draftA: string
let runningB: string
let invalidB: string

type CursorSnapshot = {
  campaign_id: string
  workspace_id: string
  space_fingerprint: string
  space_size: number
  position: number
  lap: number
  lap_started_on: string
  last_planned_on: string | null
  tier: string
  tier_changed_on: string | null
}

let foreignCursors: CursorSnapshot[] = []

// -----------------------------------------------------------------------------
// Targets
// -----------------------------------------------------------------------------

type TargetFixture = {
  version: number
  endpoint: string
  keywords: string[]
  locations: string[]
  pages: number[]
  resultsPerRequest: number
  country: string
  language: string
  notes?: string
}

/** The shape a campaign target had before ADR 0001. It must skip, not throw. */
type LegacyTarget = {
  industries: string[]
  cities: string[]
  size_bands: string[]
}

/** `tag` keeps one workspace's vocabulary disjoint from another's. */
function searchTarget(
  keywords: number,
  locations: number,
  pages: number,
  tag = 'a',
): TargetFixture {
  return {
    version: 1,
    endpoint: 'places',
    keywords: Array.from({ length: keywords }, (_, i) => `${tag} keyword-${i}`),
    locations: Array.from({ length: locations }, (_, i) => `${tag} location-${i}`),
    pages: Array.from({ length: pages }, (_, i) => i + 1),
    resultsPerRequest: 10,
    country: 'id',
    language: 'id',
  }
}

/** 10 x 10 x 1 = 100 searches; burst asks for ceil(100 / 5) = 20 a day. */
const TARGET_A = searchTarget(10, 10, 1)
const EXPECTED_A = 20

/** 5 x 10 x 1 = 50; burst asks for 10. */
const TARGET_B = searchTarget(5, 10, 1, 'b')
const EXPECTED_B = 10

const LEGACY_TARGET: LegacyTarget = {
  industries: ['Ritel'],
  cities: ['Surabaya'],
  size_bands: ['1-10'],
}

function fingerprintOf(value: unknown): string {
  const parsed = parseTarget(value)
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.error.issues.join('; ')}`)
  return fingerprintTarget(parsed.value)
}

// -----------------------------------------------------------------------------
// Request / response
// -----------------------------------------------------------------------------

/**
 * `.strict()` is load-bearing, not tidiness. ADR 0001 §6's first rule is that the
 * cross-tenant read selects plan columns and never a lead, a contact or a
 * message; an unknown key in an item fails every test in this file.
 */
const planItemSchema = z
  .object({
    campaign_id: z.string(),
    idempotency_key: z.string(),
    q: z.string(),
    gl: z.string(),
    hl: z.string(),
    num: z.number(),
    page: z.number(),
    endpoint: z.string(),
    space_index: z.number(),
    plan_date: z.string(),
  })
  .strict()

const planResponseSchema = z
  .object({
    plan_date: z.string(),
    generated_at: z.string(),
    budget: z.number(),
    item_count: z.number(),
    items: z.array(planItemSchema),
    skipped: z.array(
      z.object({ campaign_id: z.string(), reason: z.string() }).strict(),
    ),
    replayed: z.boolean(),
  })
  .strict()

type PlanResponse = z.infer<typeof planResponseSchema>

function sign(body: string): string {
  const secret = process.env.N8N_WEBHOOK_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('N8N_WEBHOOK_SECRET is not set; check .env.local')
  }
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

function request(raw: string, signature?: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  const value = signature === undefined ? sign(raw) : signature
  if (value !== null) headers.set('x-sora-signature', value)

  return new Request('http://localhost:3000/api/webhooks/n8n/plan', {
    method: 'POST',
    headers,
    body: raw,
  })
}

type PlanRequest = {
  idempotency_key: string
  plan_date?: string
  max_items?: number
  dry_run?: boolean
}

async function post(body: PlanRequest, signature?: string | null): Promise<Response> {
  return POST(request(JSON.stringify(body), signature))
}

async function plan(key: string, overrides: Partial<PlanRequest> = {}): Promise<PlanResponse> {
  const response = await post({
    idempotency_key: `${KEY_PREFIX}${key}`,
    plan_date: PLAN_DATE,
    ...overrides,
  })
  expect(response.status).toBe(200)
  const json: unknown = await response.json()
  return planResponseSchema.parse(json)
}

function itemsFor(response: PlanResponse, campaignId: string) {
  return response.items.filter((item) => item.campaign_id === campaignId)
}

function reasonFor(response: PlanResponse, campaignId: string): string | undefined {
  return response.skipped.find((entry) => entry.campaign_id === campaignId)?.reason
}

/** The workspaces owning these campaigns, whoever they belong to. */
async function workspacesOf(campaignIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(campaignIds)]
  if (unique.length === 0) return new Set()
  const rows = await sql<{ workspace_id: string }[]>`
    select distinct workspace_id from campaigns where id in ${sql(unique)}`
  return new Set(rows.map((row) => row.workspace_id))
}

async function cursorFor(campaignId: string): Promise<CursorSnapshot | undefined> {
  const rows = await sql<CursorSnapshot[]>`
    select campaign_id, workspace_id, space_fingerprint, space_size, position, lap,
           lap_started_on::text as lap_started_on, last_planned_on::text as last_planned_on,
           tier::text as tier, tier_changed_on::text as tier_changed_on
    from scrape_cursors where campaign_id = ${campaignId}`
  return rows[0]
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

async function createCampaign(
  workspaceId: string,
  name: string,
  status: string,
  target: TargetFixture | LegacyTarget,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into campaigns (workspace_id, name, status, target)
    values (${workspaceId}, ${name}, ${status}::campaign_status, ${sql.json(target)})
    returning id`
  const row = rows[0]
  if (row === undefined) throw new Error('campaign fixture failed')
  return row.id
}

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug like ${`${SLUG}%`}`
  foreignCursors = await sql<CursorSnapshot[]>`
    select campaign_id, workspace_id, space_fingerprint, space_size, position, lap,
           lap_started_on::text as lap_started_on, last_planned_on::text as last_planned_on,
           tier::text as tier, tier_changed_on::text as tier_changed_on
    from scrape_cursors`
})

afterAll(async () => {
  await sql`delete from workspaces where slug like ${`${SLUG}%`}`
  await sql`delete from webhook_events
            where provider = 'n8n_plan' and idempotency_key like ${`${KEY_PREFIX}%`}`

  // Put every tenant that is not ours back exactly where it was found. A cursor
  // created during the run for a campaign we do not own is deleted outright.
  const keep = foreignCursors.map((row) => row.campaign_id)
  if (keep.length > 0) {
    await sql`delete from scrape_cursors where campaign_id not in ${sql(keep)}`
  } else {
    await sql`delete from scrape_cursors`
  }
  for (const row of foreignCursors) {
    await sql`
      update scrape_cursors set
        space_fingerprint = ${row.space_fingerprint},
        space_size = ${row.space_size},
        position = ${row.position},
        lap = ${row.lap},
        lap_started_on = ${row.lap_started_on},
        last_planned_on = ${row.last_planned_on},
        tier = ${row.tier}::scrape_tier,
        tier_changed_on = ${row.tier_changed_on}
      where campaign_id = ${row.campaign_id} and workspace_id = ${row.workspace_id}`
  }

  await sql.end()
  // lib/db/drizzle.ts caches its pool on globalThis outside production; without
  // closing it the Vitest process would not exit.
  await globalThis.__soraPostgresClient?.end()
})

beforeEach(async () => {
  await sql`delete from workspaces where slug like ${`${SLUG}%`}`
  await sql`delete from webhook_events
            where provider = 'n8n_plan' and idempotency_key like ${`${KEY_PREFIX}%`}`

  const workspaces = await sql<{ id: string }[]>`
    insert into workspaces (name, slug)
    values ('Plan Test A', ${`${SLUG}-a`}), ('Plan Test B', ${`${SLUG}-b`})
    returning id`
  const [a, b] = workspaces
  if (a === undefined || b === undefined) throw new Error('workspace fixture failed')
  workspaceA = a.id
  workspaceB = b.id

  runningA = await createCampaign(workspaceA, 'Running A', 'running', TARGET_A)
  draftA = await createCampaign(workspaceA, 'Draft A', 'draft', TARGET_A)
  runningB = await createCampaign(workspaceB, 'Running B', 'running', TARGET_B)
  invalidB = await createCampaign(workspaceB, 'Legacy B', 'running', LEGACY_TARGET)
})

// -----------------------------------------------------------------------------

describe('POST /api/webhooks/n8n/plan — signature', () => {
  it('rejects a request with no signature', async () => {
    const response = await post({ idempotency_key: `${KEY_PREFIX}nosig` }, null)
    expect(response.status).toBe(401)
    expect(await cursorFor(runningA)).toBeUndefined()
  })

  it('rejects a signature computed with the wrong secret', async () => {
    const raw = JSON.stringify({ idempotency_key: `${KEY_PREFIX}wrongsecret` })
    const forged = `sha256=${createHmac('sha256', 'not-the-secret').update(raw).digest('hex')}`

    const response = await POST(request(raw, forged))
    expect(response.status).toBe(401)
    expect(await cursorFor(runningA)).toBeUndefined()
  })

  it('rejects a malformed signature header', async () => {
    const response = await post({ idempotency_key: `${KEY_PREFIX}malformed` }, 'sha256=zzzz')
    expect(response.status).toBe(401)
  })

  it('rejects a body altered after signing', async () => {
    const original = JSON.stringify({ idempotency_key: `${KEY_PREFIX}tamper`, max_items: 10 })
    const tampered = JSON.stringify({ idempotency_key: `${KEY_PREFIX}tamper`, max_items: 5000 })

    const response = await POST(request(tampered, sign(original)))
    expect(response.status).toBe(401)
    expect(await cursorFor(runningA)).toBeUndefined()
  })
})

describe('POST /api/webhooks/n8n/plan — payload', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await POST(request('not json at all'))
    expect(response.status).toBe(400)
  })

  it('rejects a payload that does not match the schema', async () => {
    const response = await POST(request(JSON.stringify({ plan_date: PLAN_DATE })))
    expect(response.status).toBe(422)
  })

  it('rejects a plan date that is not a date', async () => {
    const response = await POST(
      request(JSON.stringify({ idempotency_key: 'k', plan_date: '5 Januari' })),
    )
    expect(response.status).toBe(422)
  })
})

describe('POST /api/webhooks/n8n/plan — the plan', () => {
  it('plans every running campaign with a usable target, and nothing else', async () => {
    const response = await plan('plan')

    expect(itemsFor(response, runningA)).toHaveLength(EXPECTED_A)
    expect(itemsFor(response, runningB)).toHaveLength(EXPECTED_B)
    expect(itemsFor(response, draftA)).toHaveLength(0)
    expect(itemsFor(response, invalidB)).toHaveLength(0)

    expect(reasonFor(response, invalidB)).toBe('invalid_target')
    expect(reasonFor(response, draftA)).toBeUndefined()
    expect(response.plan_date).toBe(PLAN_DATE)
    expect(response.item_count).toBe(response.items.length)
    expect(response.replayed).toBe(false)
  })

  it('emits items Serper can execute without n8n composing anything', async () => {
    const response = await plan('items')
    const items = itemsFor(response, runningA)

    for (const item of items) {
      expect(item.q).toMatch(/^a keyword-\d+ a location-\d+$/)
      expect(item.gl).toBe('id')
      expect(item.hl).toBe('id')
      // The credit cliff. 11 results cost two credits and return ten.
      expect(item.num).toBeLessThanOrEqual(10)
      expect(item.page).toBe(1)
      expect(item.endpoint).toBe('places')
      expect(item.plan_date).toBe(PLAN_DATE)
      expect(item.idempotency_key).toBe(
        `plan:${PLAN_DATE}:${item.campaign_id}:${item.space_index}`,
      )
    }

    // A window out of a 100-item space, starting at the top, with no repeats.
    expect(items.map((item) => item.space_index)).toEqual(
      Array.from({ length: EXPECTED_A }, (_, i) => i),
    )
    expect(new Set(items.map((item) => item.q)).size).toBe(EXPECTED_A)
  })

  it('advances the cursor to where the window ended', async () => {
    await plan('advance')
    const cursor = await cursorFor(runningA)

    expect(cursor).toBeDefined()
    if (cursor === undefined) return
    expect(cursor.workspace_id).toBe(workspaceA)
    expect(cursor.space_fingerprint).toBe(fingerprintOf(TARGET_A))
    expect(cursor.space_size).toBe(100)
    expect(cursor.position).toBe(EXPECTED_A)
    expect(cursor.lap).toBe(0)
    expect(cursor.lap_started_on).toBe(PLAN_DATE)
    expect(cursor.last_planned_on).toBe(PLAN_DATE)
    expect(cursor.tier).toBe('burst')
  })

  it('carries on from the stored position the next day', async () => {
    await plan('day-one')
    const second = await plan('day-two', { plan_date: '2026-01-06' })

    const items = itemsFor(second, runningA)
    expect(items.map((item) => item.space_index)).toEqual(
      Array.from({ length: EXPECTED_A }, (_, i) => EXPECTED_A + i),
    )

    const cursor = await cursorFor(runningA)
    expect(cursor?.position).toBe(EXPECTED_A * 2)
    expect(cursor?.lap_started_on).toBe(PLAN_DATE)
    expect(cursor?.last_planned_on).toBe('2026-01-06')
  })

  it('takes the smaller of its own budget and what the executor will accept', async () => {
    const response = await plan('max-items', { max_items: 12 })
    expect(response.budget).toBe(12)
    expect(response.items.length).toBeLessThanOrEqual(12)
  })
})

describe('POST /api/webhooks/n8n/plan — idempotency', () => {
  it('issues nothing twice for the same key and leaves the cursor alone', async () => {
    const first = await plan('replay')
    expect(itemsFor(first, runningA)).toHaveLength(EXPECTED_A)

    const before = await cursorFor(runningA)
    const second = await plan('replay')

    expect(second.replayed).toBe(true)
    expect(itemsFor(second, runningA)).toHaveLength(0)
    expect(reasonFor(second, runningA)).toBe('already_planned')
    expect(await cursorFor(runningA)).toEqual(before)
  })

  it('issues nothing twice on the same day under a different key either', async () => {
    await plan('same-day-one')
    const before = await cursorFor(runningA)

    const second = await plan('same-day-two')
    expect(itemsFor(second, runningA)).toHaveLength(0)
    expect(reasonFor(second, runningA)).toBe('already_planned')
    expect(await cursorFor(runningA)).toEqual(before)
  })

  it('claims exactly the workspaces that contributed, and no others', async () => {
    const response = await plan('claims')

    const rows = await sql<{ workspace_id: string; idempotency_key: string }[]>`
      select workspace_id, idempotency_key from webhook_events
      where provider = 'n8n_plan' and idempotency_key like ${`${KEY_PREFIX}claims:%`}`

    // Unfiltered on purpose: a claim written for a workspace that contributed
    // nothing — ours or a foreign tenant's — has to fail this, not hide behind a
    // filter that only looks at the two workspaces this file created.
    const contributed = await workspacesOf(response.items.map((item) => item.campaign_id))
    expect(new Set(rows.map((row) => row.workspace_id))).toEqual(contributed)

    for (const row of rows) {
      expect(row.idempotency_key).toBe(
        `${KEY_PREFIX}claims:${PLAN_DATE}:${row.workspace_id}`,
      )
    }
  })

  // Defect found in review: the claim key carried no date. An n8n workflow whose
  // key is derived from its workflow or execution id — the obvious thing to
  // write — would claim every workspace on day one and then answer every later
  // day with `already_planned`, 200, zero items, indefinitely, looking healthy.
  it('binds a claim to its day, so one key still works tomorrow', async () => {
    const monday = await plan('sticky-key')
    expect(itemsFor(monday, runningA)).toHaveLength(EXPECTED_A)

    const tuesday = await plan('sticky-key', { plan_date: '2026-01-06' })
    expect(tuesday.replayed).toBe(false)
    expect(itemsFor(tuesday, runningA)).toHaveLength(EXPECTED_A)
    expect(itemsFor(tuesday, runningA)[0]?.space_index).toBe(EXPECTED_A)

    // And the same key on the same day is still a replay.
    const again = await plan('sticky-key', { plan_date: '2026-01-06' })
    expect(again.replayed).toBe(true)
    expect(itemsFor(again, runningA)).toHaveLength(0)
  })

  it('computes a dry run without writing anything', async () => {
    const dry = await plan('dry', { dry_run: true })

    expect(itemsFor(dry, runningA)).toHaveLength(EXPECTED_A)
    expect(await cursorFor(runningA)).toBeUndefined()

    const claims = await sql<{ n: number }[]>`
      select count(*)::int as n from webhook_events
      where provider = 'n8n_plan' and idempotency_key like ${`${KEY_PREFIX}dry:%`}`
    expect(claims[0]?.n).toBe(0)

    // And the real call that follows it still gets the same window.
    const wet = await plan('dry-then-wet')
    expect(itemsFor(wet, runningA).map((item) => item.space_index)).toEqual(
      itemsFor(dry, runningA).map((item) => item.space_index),
    )
  })
})

describe('POST /api/webhooks/n8n/plan — the fingerprint', () => {
  it('restarts the space when the target changes under the cursor', async () => {
    await plan('before-edit')
    const before = await cursorFor(runningA)
    expect(before?.position).toBe(EXPECTED_A)

    // One more keyword: 11 x 10 x 1 = 110, a different space and a different
    // fingerprint. The stored position indexes a space that no longer exists.
    const edited = searchTarget(11, 10, 1)
    await sql`update campaigns set target = ${sql.json(edited)}
              where id = ${runningA} and workspace_id = ${workspaceA}`

    const after = await plan('after-edit', { plan_date: '2026-01-06' })
    const items = itemsFor(after, runningA)

    expect(items[0]?.space_index).toBe(0)
    expect(items).toHaveLength(Math.ceil(110 / 5))

    const cursor = await cursorFor(runningA)
    expect(cursor?.space_fingerprint).toBe(fingerprintOf(edited))
    expect(cursor?.space_size).toBe(110)
    expect(cursor?.position).toBe(Math.ceil(110 / 5))
    expect(cursor?.lap).toBe(0)
    expect(cursor?.lap_started_on).toBe('2026-01-06')
  })

  it('keeps its place when only the note changed', async () => {
    await plan('before-note')
    const before = await cursorFor(runningA)

    const annotated = { ...searchTarget(10, 10, 1), notes: 'Catatan baru dari tim sales.' }
    await sql`update campaigns set target = ${sql.json(annotated)}
              where id = ${runningA} and workspace_id = ${workspaceA}`

    const after = await plan('after-note', { plan_date: '2026-01-06' })
    expect(itemsFor(after, runningA)[0]?.space_index).toBe(EXPECTED_A)

    const cursor = await cursorFor(runningA)
    expect(cursor?.space_fingerprint).toBe(before?.space_fingerprint)
    expect(cursor?.lap_started_on).toBe(PLAN_DATE)
  })
})

describe('POST /api/webhooks/n8n/plan — tenant isolation', () => {
  /**
   * `context.ts` is the one query in the codebase that reads across tenants
   * (ADR 0001 §6). These are the three rules that bound it.
   */
  it('writes every cursor under the workspace of its own campaign', async () => {
    await plan('isolation')

    const mismatched = await sql<{ n: number }[]>`
      select count(*)::int as n
      from scrape_cursors cur
      join campaigns c on c.id = cur.campaign_id
      where cur.workspace_id <> c.workspace_id`
    expect(mismatched[0]?.n).toBe(0)

    expect((await cursorFor(runningA))?.workspace_id).toBe(workspaceA)
    expect((await cursorFor(runningB))?.workspace_id).toBe(workspaceB)
  })

  it('returns only campaigns that exist and are running, whoever owns them', async () => {
    const response = await plan('running-only')
    const ids = [...new Set(response.items.map((item) => item.campaign_id))]

    const rows = await sql<{ id: string; status: string }[]>`
      select id, status::text as status from campaigns where id in ${sql(ids)}`

    expect(rows).toHaveLength(ids.length)
    expect(rows.every((row) => row.status === 'running')).toBe(true)
  })

  it('never lets one workspace consume another workspace window', async () => {
    const response = await plan('windows')

    const itemsA = itemsFor(response, runningA)
    const itemsB = itemsFor(response, runningB)

    // B's space is half of A's, and every q belongs to the campaign's own target.
    expect(itemsA).toHaveLength(EXPECTED_A)
    expect(itemsB).toHaveLength(EXPECTED_B)
    expect(new Set([...itemsA, ...itemsB].map((item) => item.q)).size).toBe(
      EXPECTED_A + EXPECTED_B,
    )
  })

  /**
   * `writeCursor`'s `setWhere` is the one line whose only job is the write-side
   * tenant boundary, and its failure mode is silent — the DO UPDATE becomes a
   * no-op, items still come back, and the campaign re-issues the same window
   * every day with no error and no `skipped` entry. Nothing else in this file
   * creates a cursor row that disagrees with its campaign about the workspace.
   */
  it('refuses to plan a campaign whose cursor belongs to another workspace', async () => {
    // Planted by hand: the schema permits it — `workspace_id` and `campaign_id`
    // are two independent foreign keys — and nothing but this guard stops the
    // planner writing A's progress into a row B owns.
    await sql`
      insert into scrape_cursors
        (workspace_id, campaign_id, space_fingerprint, space_size, position, lap, lap_started_on)
      values (${workspaceB}, ${runningA}, ${fingerprintOf(TARGET_A)}, 100, 55, 3, '2025-12-01')`

    // A dry run says the same thing. It writes nothing, so it has no refused
    // write to learn from — it has to have read the conflict, which is also what
    // stops the campaign consuming a share of the day's budget it cannot use.
    const dry = await plan('cross-tenant-dry', { dry_run: true })
    expect(itemsFor(dry, runningA)).toHaveLength(0)
    expect(reasonFor(dry, runningA)).toBe('cursor_not_owned')

    const before = await cursorFor(runningA)
    const response = await plan('cross-tenant-cursor')
    const after = await cursorFor(runningA)

    // Not searched, and SAID so. Returning items here would bill this campaign
    // for the same window every day for good: the write that records the sweep
    // is refused, so tomorrow it reads as never swept all over again.
    expect(itemsFor(response, runningA)).toHaveLength(0)
    expect(reasonFor(response, runningA)).toBe('cursor_not_owned')

    expect(before).toBeDefined()
    expect(after).toEqual(before)
    expect(after?.position).toBe(55)
    expect(after?.last_planned_on).toBeNull()

    // The rest of the estate is unaffected.
    expect(itemsFor(response, runningB)).toHaveLength(EXPECTED_B)
  })

  /**
   * The same corruption, one step further out of reach: the cursor row belongs
   * to a workspace with no running campaign, so it is outside the set
   * `loadCursors` reads and `context.ts` never sees it at all. Only the upsert's
   * `setWhere` can catch this shape — and `ON CONFLICT DO UPDATE` with an
   * unsatisfied predicate writes nothing and raises nothing, so it is caught
   * only because the statement asks what it wrote.
   */
  it('refuses to plan when the cursor belongs to a workspace outside the plan', async () => {
    const outsiders = await sql<{ id: string }[]>`
      insert into workspaces (name, slug) values ('Plan Test C', ${`${SLUG}-c`})
      returning id`
    const workspaceC = outsiders[0]?.id
    if (workspaceC === undefined) throw new Error('workspace fixture failed')

    await sql`
      insert into scrape_cursors
        (workspace_id, campaign_id, space_fingerprint, space_size, position, lap, lap_started_on)
      values (${workspaceC}, ${runningA}, ${fingerprintOf(TARGET_A)}, 100, 55, 3, '2025-12-01')`

    const before = await cursorFor(runningA)
    const response = await plan('outside-cursor')

    expect(itemsFor(response, runningA)).toHaveLength(0)
    expect(reasonFor(response, runningA)).toBe('cursor_not_owned')
    expect(await cursorFor(runningA)).toEqual(before)
  })

  it('leaves a workspace that contributed nothing byte-identical', async () => {
    await plan('quiet-b-day-one')
    const before = await cursorFor(runningB)
    expect(before).toBeDefined()

    // B stops running, so the next plan is A's alone.
    await sql`update campaigns set status = 'paused'
              where workspace_id = ${workspaceB}`

    const second = await plan('quiet-b-day-two', { plan_date: '2026-01-06' })
    expect(itemsFor(second, runningA)).toHaveLength(EXPECTED_A)
    expect(itemsFor(second, runningB)).toHaveLength(0)
    expect(reasonFor(second, runningB)).toBeUndefined()

    expect(await cursorFor(runningB)).toEqual(before)

    const claims = await sql<{ workspace_id: string }[]>`
      select workspace_id from webhook_events
      where provider = 'n8n_plan'
        and idempotency_key like ${`${KEY_PREFIX}quiet-b-day-two:%`}`
    expect(claims.some((row) => row.workspace_id === workspaceB)).toBe(false)
  })
})

/**
 * Two requests in flight at once, with DIFFERENT keys — so nothing in the claim
 * index makes them collide. Without a row lock in `loadPlanCandidates`, both read
 * `last_planned_on = null`, compute the identical window from the identical
 * position, and n8n is handed the same searches twice on the same Serper
 * account. This races them for real rather than asserting the lock exists.
 */
describe('POST /api/webhooks/n8n/plan — concurrency', () => {
  it('issues one window when two plans race for the same day', async () => {
    const [first, second] = await Promise.all([
      plan('race-one'),
      plan('race-two'),
    ])

    const items = [...itemsFor(first, runningA), ...itemsFor(second, runningA)]
    expect(items).toHaveLength(EXPECTED_A)
    expect(new Set(items.map((item) => item.space_index)).size).toBe(EXPECTED_A)

    // One of them planned; the other found the day already spoken for.
    const planned = [first, second].filter((r) => itemsFor(r, runningA).length > 0)
    const empty = [first, second].filter((r) => itemsFor(r, runningA).length === 0)
    expect(planned).toHaveLength(1)
    expect(empty).toHaveLength(1)
    expect(reasonFor(empty[0] ?? first, runningA)).toBe('already_planned')

    const cursor = await cursorFor(runningA)
    expect(cursor?.position).toBe(EXPECTED_A)
    expect(cursor?.lap).toBe(0)
  })
})

describe('POST /api/webhooks/n8n/plan — the wire shape', () => {
  /**
   * `hl` was bounded at 10 characters in the response schema while `language`
   * parses up to 11. One campaign with an 11-character tag committed its cursor
   * and then failed serialisation — 500, no items, FOR EVERY TENANT in the plan,
   * with the cursors and claims already durable, so the retry answered
   * `already_planned` and the day was gone estate-wide.
   */
  it('plans a campaign whose language tag is as long as the target allows', async () => {
    const longTag = { ...searchTarget(5, 4, 1, 'c'), language: 'id-Latn1234' }
    expect(longTag.language).toHaveLength(11)

    const campaign = await createCampaign(workspaceA, 'Long Tag', 'running', longTag)
    const response = await plan('long-language-tag')

    const items = itemsFor(response, campaign)
    expect(items).toHaveLength(Math.ceil(20 / 5))
    expect(items.every((item) => item.hl === 'id-Latn1234')).toBe(true)

    // The rest of the estate was planned too, not taken down with it.
    expect(itemsFor(response, runningA)).toHaveLength(EXPECTED_A)
    expect(itemsFor(response, runningB)).toHaveLength(EXPECTED_B)
    expect((await cursorFor(campaign))?.position).toBe(4)
  })

  it('stamps lap_started_on when a window wraps past the end of the space', async () => {
    // 3 x 2 x 1 = 6, so burst asks for ceil(6 / 5) = 2 a day.
    const small = searchTarget(3, 2, 1, 'd')
    const campaign = await createCampaign(workspaceA, 'Small Space', 'running', small)

    // Parked one short of the end, on a lap that started last year.
    await sql`
      insert into scrape_cursors
        (workspace_id, campaign_id, space_fingerprint, space_size, position, lap, lap_started_on)
      values (${workspaceA}, ${campaign}, ${fingerprintOf(small)}, 6, 5, 0, '2025-12-01')`

    const response = await plan('wrap')
    expect(itemsFor(response, campaign).map((item) => item.space_index)).toEqual([5, 0])

    const cursor = await cursorFor(campaign)
    expect(cursor?.lap).toBe(1)
    expect(cursor?.position).toBe(1)
    expect(cursor?.lap_started_on).toBe(PLAN_DATE)
  })
})
