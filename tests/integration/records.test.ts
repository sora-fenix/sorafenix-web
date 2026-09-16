import type postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { exportLeads, listCompanies, listLeads } from '@/lib/db/queries/records'
import { pageRequest } from '@/lib/pagination'

import { openDatabase } from './helpers'

/**
 * Pagination against real Postgres.
 *
 * `tests/unit/pagination.test.ts` owns the arithmetic. What only a database can
 * show is the property the arithmetic is for: that walking the pages visits every
 * row exactly once. Ties make that fail — 935 of the 1208 scraped leads share a
 * band and many share a score — so the ordering carries a unique tiebreaker, and
 * the test below is what would catch its removal.
 *
 * Its own workspaces, deleted afterwards: seed.test.ts asserts exact counts in
 * `maju-bersama`.
 */

const SLUG = 'records-test-workspace'
const OTHER = `${SLUG}-other`
const LEAD_COUNT = 7
const PAGE_SIZE = 3

let sql: postgres.Sql
let workspaceId: string
let otherWorkspaceId: string

async function seedLeads(workspace: string, count: number, prefix: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const [company] = await sql<{ id: string }[]>`
      insert into companies (workspace_id, name, address, city, country)
      values (${workspace}, ${`${prefix} ${String(i).padStart(2, '0')}`},
              ${`Jl. Contoh No. ${String(i)}`}, 'Surabaya', 'ID')
      returning id`
    if (company === undefined) throw new Error('company fixture failed')

    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (workspace_id, company_id, whatsapp)
      values (${workspace}, ${company.id}, ${`+62812000000${String(i)}`})
      returning id`
    if (contact === undefined) throw new Error('contact fixture failed')

    // Every lead scores 70 on purpose. Without a unique tiebreaker in the ORDER BY,
    // Postgres may return these in any order per query, and paging would then show
    // one row twice and another never.
    await sql`
      insert into leads (workspace_id, company_id, contact_id, status, score, category)
      values (${workspace}, ${company.id}, ${contact.id}, 'qualified', 70, 'warm')`
  }
}

beforeAll(async () => {
  sql = openDatabase()
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER})`

  const [ws] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Records Test', ${SLUG}) returning id`
  const [other] = await sql<{ id: string }[]>`
    insert into workspaces (name, slug) values ('Records Other', ${OTHER}) returning id`
  if (ws === undefined || other === undefined) throw new Error('workspace fixture failed')
  workspaceId = ws.id
  otherWorkspaceId = other.id

  await seedLeads(workspaceId, LEAD_COUNT, 'Petshop')
  await seedLeads(otherWorkspaceId, 4, 'Toko Lain')
})

afterAll(async () => {
  await sql`delete from workspaces where slug in (${SLUG}, ${OTHER})`
  await sql.end()
  await globalThis.__soraPostgresClient?.end()
})

// -----------------------------------------------------------------------------

describe('paging through leads', () => {
  it('reports the true total, not the size of the page', () => {
    // The bug this replaces: the screen showed 100 of 1208 and said "100".
    return listLeads(workspaceId, pageRequest('1', PAGE_SIZE)).then((page) => {
      expect(page.total).toBe(LEAD_COUNT)
      expect(page.rows).toHaveLength(PAGE_SIZE)
      expect(page.totalPages).toBe(3)
      expect(page.from).toBe(1)
      expect(page.to).toBe(3)
    })
  })

  it('visits every lead exactly once across the pages, despite identical scores', async () => {
    const seen: string[] = []
    for (let page = 1; page <= 3; page += 1) {
      const result = await listLeads(workspaceId, pageRequest(String(page), PAGE_SIZE))
      seen.push(...result.rows.map((row) => row.id))
    }

    expect(seen).toHaveLength(LEAD_COUNT)
    expect(new Set(seen).size).toBe(LEAD_COUNT)

    // The assertion with teeth. Every score here is 70, so the id tiebreaker is
    // the only thing deciding the order, and ids are random UUIDs while the rows
    // were inserted in a different sequence entirely. Without the tiebreaker the
    // rows come back in physical order and this is not sorted; "no duplicates"
    // alone passes either way on a table this small, which is why it is not the
    // check being relied on.
    expect(seen).toEqual([...seen].sort())
  })

  it('gives the same page the same rows when asked twice', async () => {
    const first = await listLeads(workspaceId, pageRequest('2', PAGE_SIZE))
    const again = await listLeads(workspaceId, pageRequest('2', PAGE_SIZE))
    expect(again.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id))
  })

  it('fills the last page partially and closes the range there', async () => {
    const last = await listLeads(workspaceId, pageRequest('3', PAGE_SIZE))
    expect(last.rows).toHaveLength(1)
    expect(last.from).toBe(7)
    expect(last.to).toBe(7)
    expect(last.hasNext).toBe(false)
  })

  it('clamps a page past the end back to the last one, rather than showing nothing', async () => {
    const far = await listLeads(workspaceId, pageRequest('900', PAGE_SIZE))
    expect(far.page).toBe(3)
    expect(far.rows).toHaveLength(1)
  })

  it('counts and lists only this workspace', async () => {
    const mine = await listLeads(workspaceId, pageRequest('1', 100))
    const theirs = await listLeads(otherWorkspaceId, pageRequest('1', 100))

    expect(mine.total).toBe(LEAD_COUNT)
    expect(theirs.total).toBe(4)
    for (const row of mine.rows) {
      expect(row.companyName?.startsWith('Petshop')).toBe(true)
    }
  })
})

describe('paging through companies', () => {
  it('paginates and counts the same way', async () => {
    const page = await listCompanies(workspaceId, pageRequest('2', PAGE_SIZE))
    expect(page.total).toBe(LEAD_COUNT)
    expect(page.page).toBe(2)
    expect(page.rows).toHaveLength(PAGE_SIZE)
  })
})

describe('the CSV export query', () => {
  it('returns every lead, not the page the screen happened to show', async () => {
    const rows = await exportLeads(workspaceId)
    expect(rows).toHaveLength(LEAD_COUNT)
  })

  it('never crosses a workspace boundary', async () => {
    const rows = await exportLeads(workspaceId)
    for (const row of rows) {
      expect(row.companyName?.startsWith('Toko Lain')).toBe(false)
    }
    expect(await exportLeads(otherWorkspaceId)).toHaveLength(4)
  })

  it('carries the columns the file needs', async () => {
    const [row] = await exportLeads(workspaceId)
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(row.whatsapp).toMatch(/^\+62/)
    expect(row.address).toMatch(/^Jl\. Contoh No\./)
    expect(row.score).toBe(70)
    expect(row.status).toBe('qualified')
    expect(row.createdAt).toBeInstanceOf(Date)
  })
})
