import type postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { classifyLeads } from '@/lib/scoring/classify'
import { SIGNAL_RUBRIC } from '@/lib/scoring/signals'

import { openDatabase } from './helpers'

/**
 * Deterministic lead classification against real Postgres.
 *
 * `tests/unit/signals.test.ts` already pins what the rubric decides. What is only
 * provable here is what it *writes*: the score and the breakdown, the audit row,
 * the status rule, and the fact that none of it crosses a workspace boundary —
 * which matters more than usual for this module, because it is the one that runs
 * over 1208 rows at a time on a Drizzle handle that bypasses RLS.
 *
 * No model is faked here because none is involved. That is the whole point of the
 * module, and it is why this file has no scripted provider at all.
 *
 * Its own workspaces, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'classify-test-workspace'
const OTHER = `${SLUG}-other`

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string

type LeadRow = {
  score: number | null
  category: string | null
  score_factors: unknown
  score_reason: string | null
  status: string
}

async function leadRow(id: string): Promise<LeadRow> {
  const [row] = await sql<LeadRow[]>`
    select score, category, score_factors, score_reason, status from leads where id = ${id}`
  if (row === undefined) throw new Error('lead fixture disappeared')
  return row
}

type ActivityRow = { type: string; actor: string; payload: Record<string, unknown> }

async function activitiesFor(id: string): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    select type, actor, payload from activities
    where lead_id = ${id} order by created_at, id`
}

/**
 * One company + contact + lead, with exactly the signals the caller names.
 *
 * `strong` and `weak` below are the two ends of the scale, built only out of
 * columns the scraper actually fills.
 */
async function makeLead(options: {
  workspace?: string
  name: string
  rating: number | null
  reviewCount: number | null
  domain?: string | null
  whatsapp?: string | null
  city?: string | null
  category?: string | null
  status?: string
}): Promise<string> {
  const ws = options.workspace ?? workspaceId

  const [company] = await sql<{ id: string }[]>`
    insert into companies (workspace_id, name, industry, city, rating, review_count, domain, website)
    values (${ws}, ${options.name}, ${options.category ?? 'Toko Hewan Peliharaan'},
            ${options.city ?? 'Surabaya'}, ${options.rating}, ${options.reviewCount},
            ${options.domain ?? null}, ${options.domain === undefined || options.domain === null ? null : `https://${options.domain}`})
    returning id`
  if (company === undefined) throw new Error('company fixture failed')

  const [contact] = await sql<{ id: string }[]>`
    insert into contacts (workspace_id, company_id, whatsapp, phone)
    values (${ws}, ${company.id}, ${options.whatsapp ?? null}, ${options.whatsapp ?? null})
    returning id`
  if (contact === undefined) throw new Error('contact fixture failed')

  const [lead] = await sql<{ id: string }[]>`
    insert into leads (workspace_id, company_id, contact_id, status)
    values (${ws}, ${company.id}, ${contact.id}, ${options.status ?? 'new'})
    returning id`
  if (lead === undefined) throw new Error('lead fixture failed')

  return lead.id
}

const strong = {
  name: 'Petshop Bintang Sembilan',
  rating: 4.9,
  reviewCount: 400,
  domain: 'bintangsembilan.co.id',
  whatsapp: '+628123456789',
} as const

const weak = {
  name: 'Toko Plastik Sumber Rejeki',
  rating: 3.6,
  reviewCount: 1,
  category: 'Toko umum',
  city: 'Jayapura',
} as const

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Classify Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Classify Other', ${OTHER}) returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')
  workspaceId = ws.id
  otherWorkspaceId = other.id
})

beforeEach(async () => {
  await sql`delete from companies where workspace_id in (${workspaceId}, ${otherWorkspaceId})`
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('what classification writes', () => {
  it('stores the score, the band, the breakdown and a reason in Bahasa Indonesia', async () => {
    const leadId = await makeLead(strong)

    const result = await classifyLeads({ workspaceId })
    expect(result.considered).toBe(1)

    const row = await leadRow(leadId)
    expect(row.score).toBeGreaterThanOrEqual(80)
    expect(row.category).toBe('hot')
    expect(row.score_reason).toContain('Prospek')
    expect(Array.isArray(row.score_factors)).toBe(true)
  })

  it('stores factors whose weighted mean is the stored score', async () => {
    // The same invariant seed.test.ts and qualify.test.ts assert. All three
    // origins satisfy it, or `leads.score` means something different depending on
    // who wrote the row.
    const leadId = await makeLead(strong)
    await classifyLeads({ workspaceId })

    const row = await leadRow(leadId)
    const factors = row.score_factors
    if (!Array.isArray(factors)) throw new Error('score_factors is not an array')

    // Reflect.get rather than a cast — rule 9 forbids an unchecked assertion, and
    // qualify.test.ts reads its stored factors the same way.
    let weighted = 0
    let weight = 0
    for (const factor of factors) {
      const item: unknown = factor
      if (typeof item !== 'object' || item === null) throw new Error('bad factor row')
      const score: unknown = Reflect.get(item, 'score')
      const factorWeight: unknown = Reflect.get(item, 'weight')
      if (typeof score !== 'number' || typeof factorWeight !== 'number') {
        throw new Error('bad factor row')
      }
      weighted += score * factorWeight
      weight += factorWeight
    }

    expect(factors).toHaveLength(6)
    expect(weight).toBe(100)
    expect(Math.round(weighted / 100)).toBe(row.score)
  })

  it('writes one audit row naming system, not ai, and naming the rubric', async () => {
    const leadId = await makeLead(strong)
    await classifyLeads({ workspaceId })

    const activities = await activitiesFor(leadId)
    const scored = activities.filter((row) => row.type === 'lead_scored')
    expect(scored).toHaveLength(1)
    expect(scored[0]?.actor).toBe('system')
    // Both rubrics write leads.score. Without this key the trail cannot say which
    // one produced a given number.
    expect(scored[0]?.payload.rubric).toBe(SIGNAL_RUBRIC)
  })
})

describe('the status rule', () => {
  it('moves a hot lead to qualified', async () => {
    const leadId = await makeLead(strong)
    await classifyLeads({ workspaceId })
    expect((await leadRow(leadId)).status).toBe('qualified')
  })

  it('leaves a cold lead at new — a weak lead is not a qualified one', async () => {
    const leadId = await makeLead(weak)
    await classifyLeads({ workspaceId })

    const row = await leadRow(leadId)
    expect(row.category).toBe('cold')
    expect(row.status).toBe('new')
    // Scored but not moved: the score is still written, and no status_changed row
    // claims a transition that did not happen.
    expect(row.score).not.toBeNull()
    const activities = await activitiesFor(leadId)
    expect(activities.filter((item) => item.type === 'status_changed')).toHaveLength(0)
  })

  it('never drags a lead a salesperson has already worked back to qualified', async () => {
    const leadId = await makeLead({ ...strong, status: 'contacted' })

    const result = await classifyLeads({ workspaceId })
    // A contacted lead is not a candidate at all — it is nobody's to re-judge.
    expect(result.considered).toBe(0)
    expect((await leadRow(leadId)).status).toBe('contacted')
  })
})

describe('re-running', () => {
  it('skips leads that already carry a score', async () => {
    await makeLead(strong)
    expect((await classifyLeads({ workspaceId })).considered).toBe(1)
    expect((await classifyLeads({ workspaceId })).considered).toBe(0)
  })

  it('redoes them on demand, and lands on the same number', async () => {
    const leadId = await makeLead(strong)
    await classifyLeads({ workspaceId })
    const first = await leadRow(leadId)

    const again = await classifyLeads({ workspaceId, reclassify: true })
    expect(again.considered).toBe(1)

    const second = await leadRow(leadId)
    expect(second.score).toBe(first.score)
    expect(second.category).toBe(first.category)
  })

  it('writes nothing at all on a dry run', async () => {
    const leadId = await makeLead(strong)

    const result = await classifyLeads({ workspaceId, dryRun: true })
    expect(result.considered).toBe(1)
    expect(result.hot).toBe(1)

    const row = await leadRow(leadId)
    expect(row.score).toBeNull()
    expect(row.status).toBe('new')
    expect(await activitiesFor(leadId)).toHaveLength(0)
  })
})

describe('tenant isolation', () => {
  it('never reads or writes a lead in another workspace', async () => {
    // CLAUDE.md rule 6: Drizzle connects privileged and bypasses RLS, so this is
    // the only thing standing between one tenant's sweep and another's data.
    const mine = await makeLead(strong)
    const theirs = await makeLead({ ...strong, workspace: otherWorkspaceId })

    const result = await classifyLeads({ workspaceId })

    expect(result.considered).toBe(1)
    expect(result.classified[0]?.leadId).toBe(mine)

    const untouched = await leadRow(theirs)
    expect(untouched.score).toBeNull()
    expect(untouched.status).toBe('new')
  })
})

describe('the batch', () => {
  it('classifies every candidate and counts the bands it produced', async () => {
    await makeLead(strong)
    // Its own domain: companies_workspace_domain_key is unique per workspace, so
    // two fixtures sharing one would collide before the rubric ever ran.
    await makeLead({ ...strong, name: 'Petshop Dua', domain: 'petshopdua.co.id' })
    await makeLead(weak)

    const result = await classifyLeads({ workspaceId })

    expect(result.considered).toBe(3)
    expect(result.hot + result.warm + result.cold).toBe(3)
    expect(result.cold).toBe(1)
    expect(result.qualified).toBe(result.hot + result.warm)
  })

  it('honours a limit', async () => {
    await makeLead(strong)
    await makeLead({ ...strong, name: 'Petshop Dua', domain: 'petshopdua.co.id' })

    expect((await classifyLeads({ workspaceId, limit: 1 })).considered).toBe(1)
  })
})
