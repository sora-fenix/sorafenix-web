/**
 * Demo seed. Builds one fully-populated workspace so every screen has realistic
 * data without a single external service.
 *
 *   pnpm db:seed
 *
 * Deterministic: a fixed-seed PRNG plus UUIDv5 identifiers derived from stable
 * names, so two runs produce byte-identical rows.
 *
 * Idempotent, and here is the honest description of how: the script OWNS the
 * `maju-bersama` workspace and rebuilds it. It deletes that one workspace row —
 * which cascades to every domain table — and re-inserts. It never touches any
 * other workspace, and it refuses to run against NODE_ENV=production. Auth users
 * are upserted by email and are never deleted.
 *
 * Talks to Postgres directly rather than through lib/db/drizzle.ts, because that
 * module imports `server-only`, which refuses to load outside the Next runtime.
 */

import { createHash } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import {
  ACTIVITY_TYPES,
  ADJACENT_INDUSTRIES,
  CITIES,
  COMPANY_PREFIXES,
  COMPANY_WORDS_A,
  COMPANY_WORDS_B,
  EMAIL_BODY_TEMPLATE,
  EMAIL_SUBJECTS,
  EVIDENCE_TEMPLATES,
  FIRST_NAMES,
  ICP_CITY_NAMES,
  ICP_INDUSTRIES,
  ICP_SIZE_BANDS,
  INBOUND_REPLIES,
  LAST_NAMES,
  LEVEL_SCORE_RANGE,
  OFF_TARGET_INDUSTRIES,
  POSITIONS,
  REASON_TEMPLATES,
  SCORE_FACTORS,
  SIZE_BANDS,
  STREETS,
  WA_TEMPLATE_BODY,
  createRng,
  emailLocalPart,
  interpolate,
  intBetween,
  mobileNumber,
  pick,
  slugifyCompany,
  type FitLevel,
} from './seed-data'
import * as schema from '../lib/db/schema'

config({ path: '.env.local', quiet: true })

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const WORKSPACE_SLUG = 'maju-bersama'
const WORKSPACE_NAME = 'PT Maju Bersama Digital'
const COMPANY_COUNT = 60
const ACTIVITY_COUNT = 150
const INBOUND_COUNT = 20
const SEQUENCE_RUN_COUNT = 25

const SEED_USERS = [
  {
    email: 'budi.santoso@majubersama.co.id',
    name: 'Budi Santoso',
    role: 'owner' as const,
  },
  {
    email: 'siti.rahayu@majubersama.co.id',
    name: 'Siti Rahayu',
    role: 'manager' as const,
  },
  {
    email: 'agus.pratama@majubersama.co.id',
    name: 'Agus Pratama',
    role: 'sales' as const,
  },
]

/** Sums to COMPANY_COUNT, and every lead_status value appears at least twice. */
const STATUS_PLAN: ReadonlyArray<[schema.LeadStatus, number]> = [
  ['new', 12],
  ['qualified', 10],
  ['contacted', 9],
  ['replied', 6],
  ['interested', 5],
  ['meeting', 4],
  ['proposal', 3],
  ['negotiation', 3],
  ['won', 3],
  ['lost', 3],
  ['do_not_contact', 2],
]

/**
 * Which fit tier a status implies. This is what makes the demo data coherent:
 * a lead that reached `negotiation` gets ICP attributes (right industry, a
 * decision-maker contact, an ideal size band), and those attributes are then
 * what its score is computed from. A construction company can therefore never
 * turn up as a hot lead for a POS product.
 */
const TIER_BY_STATUS: Record<schema.LeadStatus, FitLevel> = {
  new: 'mid',
  qualified: 'mid',
  contacted: 'mid',
  replied: 'mid',
  interested: 'high',
  meeting: 'high',
  proposal: 'high',
  negotiation: 'high',
  won: 'high',
  lost: 'low',
  do_not_contact: 'low',
}

/**
 * Outbound message statuses and how many of each to create. Together with
 * INBOUND_COUNT this is the 90 messages tests/integration/seed.test.ts expects.
 */
const OUTBOUND_PLAN: ReadonlyArray<[schema.MessageStatus, number]> = [
  ['draft', 8],
  ['needs_input', 6],
  ['pending_approval', 10],
  ['approved', 4],
  ['queued', 3],
  ['sent', 12],
  ['delivered', 10],
  ['opened', 9],
  ['replied', 5],
  ['bounced', 2],
  ['failed', 1],
]

// -----------------------------------------------------------------------------
// Deterministic identifiers
// -----------------------------------------------------------------------------

/** Fixed namespace so ids are stable across machines and runs. */
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/** RFC 4122 v5 (SHA-1). Node has randomUUID but no name-based generator. */
function uuidv5(name: string): string {
  const hex = UUID_NAMESPACE.replace(/-/g, '')
  const nsBytes = Buffer.from(hex, 'hex')
  const hash = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))

  const b6 = bytes[6]
  const b8 = bytes[8]
  if (b6 === undefined || b8 === undefined) {
    throw new Error('uuidv5: digest shorter than 16 bytes')
  }
  bytes[6] = (b6 & 0x0f) | 0x50
  bytes[8] = (b8 & 0x3f) | 0x80

  const s = bytes.toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

const id = {
  workspace: uuidv5(`workspace:${WORKSPACE_SLUG}`),
  product: uuidv5('product:pos-kasir-pro'),
  knowledgeDoc: (key: string) => uuidv5(`knowledge:${key}`),
  integration: (provider: string) => uuidv5(`integration:${provider}`),
  campaign: (key: string) => uuidv5(`campaign:${key}`),
  company: (i: number) => uuidv5(`company:${i}`),
  contact: (i: number) => uuidv5(`contact:${i}`),
  lead: (i: number) => uuidv5(`lead:${i}`),
  activity: (i: number) => uuidv5(`activity:${i}`),
  message: (i: number) => uuidv5(`message:${i}`),
  sequenceRun: (i: number) => uuidv5(`sequence_run:${i}`),
  suppression: (i: number) => uuidv5(`suppression:${i}`),
  aiRun: (i: number) => uuidv5(`ai_run:${i}`),
  webhookEvent: (i: number) => uuidv5(`webhook_event:${i}`),
}

// -----------------------------------------------------------------------------
// Time helpers — all relative to a fixed "now" so the data reads as current
// -----------------------------------------------------------------------------

const NOW = new Date()

function daysAgo(days: number, hourOffset = 0): Date {
  const d = new Date(NOW)
  d.setDate(d.getDate() - days)
  d.setHours(9 + hourOffset, 0, 0, 0)
  return d
}

function daysAhead(days: number, hourOffset = 0): Date {
  return daysAgo(-days, hourOffset)
}

// -----------------------------------------------------------------------------
// Auth users
// -----------------------------------------------------------------------------

type SeededUser = { id: string; email: string; name: string; role: schema.Membership['role'] }

async function ensureUsers(supabase: SupabaseClient): Promise<SeededUser[]> {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (error !== null) {
    throw new Error(`Could not list Supabase users: ${error.message}`)
  }

  const existing = new Map(
    data.users.flatMap((user) =>
      user.email === undefined ? [] : [[user.email.toLowerCase(), user.id]],
    ),
  )

  const result: SeededUser[] = []
  for (const spec of SEED_USERS) {
    const found = existing.get(spec.email.toLowerCase())
    if (found !== undefined) {
      result.push({ id: found, ...spec })
      continue
    }

    const created = await supabase.auth.admin.createUser({
      email: spec.email,
      // Confirmed up front so the magic link works on the first try.
      email_confirm: true,
      user_metadata: { full_name: spec.name },
    })
    if (created.error !== null || created.data.user === null) {
      throw new Error(
        `Could not create user ${spec.email}: ${created.error?.message ?? 'no user returned'}`,
      )
    }
    result.push({ id: created.data.user.id, ...spec })
  }

  return result
}

// -----------------------------------------------------------------------------
// Row builders
// -----------------------------------------------------------------------------

type BuiltCompany = {
  company: schema.NewCompany
  contact: schema.NewContact
  lead: schema.NewLead
  industry: string
  city: string
  contactName: string
}

function buildStatusSequence(): schema.LeadStatus[] {
  const out: schema.LeadStatus[] = []
  for (const [status, count] of STATUS_PLAN) {
    for (let i = 0; i < count; i += 1) out.push(status)
  }
  return out
}

function buildCompanies(
  rng: () => number,
  users: SeededUser[],
  campaignIds: string[],
): BuiltCompany[] {
  const statuses = buildStatusSequence()
  const owners = users.filter((u) => u.role !== 'owner')
  const built: BuiltCompany[] = []
  const usedDomains = new Set<string>()

  for (let i = 0; i < COMPANY_COUNT; i += 1) {
    const status = statuses[i] ?? 'new'
    const tier = TIER_BY_STATUS[status]

    const prefix = pick(rng, COMPANY_PREFIXES)
    const wordA = pick(rng, COMPANY_WORDS_A)
    const wordB = pick(rng, COMPANY_WORDS_B)
    const name = `${prefix} ${wordA} ${wordB}`

    // Attributes are drawn from the pool matching the tier, so the record and the
    // score it earns tell the same story.
    const industry =
      tier === 'high'
        ? pick(rng, ICP_INDUSTRIES)
        : tier === 'mid'
          ? pick(rng, [...ICP_INDUSTRIES, ...ADJACENT_INDUSTRIES])
          : pick(rng, OFF_TARGET_INDUSTRIES)

    const cityPool =
      tier === 'high'
        ? CITIES.filter((c) => ICP_CITY_NAMES.includes(c.name))
        : tier === 'low'
          ? CITIES.filter((c) => !ICP_CITY_NAMES.includes(c.name))
          : CITIES
    const city = pick(rng, cityPool)

    const size =
      tier === 'high'
        ? pick(rng, SIZE_BANDS.filter((b) => ICP_SIZE_BANDS.includes(b.band)))
        : tier === 'low'
          ? pick(rng, SIZE_BANDS.filter((b) => !ICP_SIZE_BANDS.includes(b.band)))
          : pick(rng, SIZE_BANDS)

    const position =
      tier === 'high'
        ? pick(rng, POSITIONS.filter((p) => p.decisionMaker))
        : tier === 'low'
          ? pick(rng, POSITIONS.filter((p) => !p.decisionMaker))
          : pick(rng, POSITIONS)

    const firstName = pick(rng, FIRST_NAMES)
    // A few names appear in both pools; "Sari Sari" reads as broken test data.
    let lastName = pick(rng, LAST_NAMES)
    while (lastName === firstName) lastName = pick(rng, LAST_NAMES)
    const contactName = `${firstName} ${lastName}`
    const mobile = mobileNumber(rng)
    const employeeCount = intBetween(rng, size.min, size.max)

    // The unique index is partial on (workspace_id, domain); a collision from the
    // random name pool must become a distinct domain, not a failed insert.
    let domain = `${slugifyCompany(name)}.co.id`
    let suffix = 2
    while (usedDomains.has(domain)) {
      domain = `${slugifyCompany(name)}${suffix}.co.id`
      suffix += 1
    }
    usedDomains.add(domain)

    // --- scoring ------------------------------------------------------------
    // Mirrors docs/SPEC.md §4: per-factor sub-scores are derived from the row's
    // real attributes, and the weighted total is computed here in code — the
    // model never returns the final number.
    const vars: Record<string, string> = {
      company: name,
      industry,
      city: city.name,
      position: position.title,
      employees: String(employeeCount),
      size: size.band,
      domain,
    }

    const industryLevel: FitLevel = ICP_INDUSTRIES.some((v) => v === industry)
      ? 'high'
      : ADJACENT_INDUSTRIES.some((v) => v === industry)
        ? 'mid'
        : 'low'
    const sizeLevel: FitLevel = ICP_SIZE_BANDS.includes(size.band)
      ? 'high'
      : size.band === '201-500'
        ? 'mid'
        : 'low'
    const levels: Record<string, FitLevel> = {
      industry_fit: industryLevel,
      product_need:
        industryLevel === 'high' && sizeLevel === 'high'
          ? 'high'
          : industryLevel === 'low'
            ? 'low'
            : 'mid',
      company_size: sizeLevel,
      decision_maker: position.decisionMaker ? 'high' : tier === 'low' ? 'low' : 'mid',
      location: ICP_CITY_NAMES.includes(city.name) ? 'high' : 'mid',
      digital_signals: sizeLevel === 'low' ? 'mid' : 'high',
    }

    const factors = SCORE_FACTORS.map((factor) => {
      const level = levels[factor.key] ?? 'mid'
      const [lo, hi] = LEVEL_SCORE_RANGE[level]
      const template =
        EVIDENCE_TEMPLATES[factor.key]?.[level] ?? 'Tidak ada bukti tersimpan.'
      return {
        key: factor.key,
        label: factor.label,
        weight: factor.weight,
        score: intBetween(rng, lo, hi),
        evidence: interpolate(template, vars),
      }
    })

    const score = Math.round(
      factors.reduce((acc, f) => acc + f.score * f.weight, 0) / 100,
    )
    const category: schema.LeadCategory =
      score >= 80 ? 'hot' : score >= 50 ? 'warm' : 'cold'

    const closed = status === 'won' || status === 'lost' || status === 'do_not_contact'
    const createdAt = daysAgo(intBetween(rng, 3, 75))
    const lastActivity = daysAgo(intBetween(rng, 0, 20))
    const owner = owners[i % owners.length] ?? users[0]

    built.push({
      industry,
      city: city.name,
      contactName,
      company: {
        id: id.company(i),
        workspaceId: id.workspace,
        name,
        domain,
        website: `https://${domain}`,
        industry,
        city: city.name,
        country: 'ID',
        sizeBand: size.band,
        employeeCount,
        description: `${name} bergerak di bidang ${industry.toLowerCase()} dan beroperasi di ${city.name}.`,
        source: i % 5 === 0 ? 'serper_search' : 'serper_places',
        sourceUrl: `https://www.google.com/maps/place/${encodeURIComponent(name)}`,
        raw: {
          // Kept exactly as a scraper would have found it. lib/leads/dedupe.ts
          // normalises 08xx / 62xx / +62xx to the single value in contacts.phone.
          phone_raw: mobile.raw,
          address: `${pick(rng, STREETS)} No. ${intBetween(rng, 1, 180)}, ${city.name}`,
          category: industry,
        },
        dedupeKey: domain,
        createdAt,
        updatedAt: lastActivity,
      },
      contact: {
        id: id.contact(i),
        workspaceId: id.workspace,
        companyId: id.company(i),
        name: contactName,
        position: position.title,
        department: position.department,
        email: `${emailLocalPart(contactName)}@${domain}`,
        phone: mobile.e164,
        whatsapp: mobile.e164,
        source: 'website_scrape',
        emailStatus: i % 17 === 0 ? 'bounced' : i % 3 === 0 ? 'valid' : 'unknown',
        optOutAt: status === 'do_not_contact' ? daysAgo(intBetween(rng, 1, 14)) : null,
        createdAt,
        updatedAt: lastActivity,
      },
      lead: {
        id: id.lead(i),
        workspaceId: id.workspace,
        campaignId: campaignIds[i % campaignIds.length] ?? null,
        companyId: id.company(i),
        contactId: id.contact(i),
        score,
        category,
        scoreFactors: factors,
        scoreReason: interpolate(REASON_TEMPLATES[category], vars),
        status,
        ownerId: owner?.id ?? null,
        lastActivityAt: status === 'new' ? null : lastActivity,
        nextActionAt: closed
          ? null
          : i % 4 === 0
            ? daysAgo(intBetween(rng, 1, 5), 2) // overdue, shows up in today's queue
            : daysAhead(intBetween(rng, 0, 12), 2),
        createdAt,
        updatedAt: lastActivity,
      },
    })
  }

  return built
}

function buildMessages(
  rng: () => number,
  built: BuiltCompany[],
  users: SeededUser[],
): schema.NewMessage[] {
  // Only leads that have actually been worked can carry messages.
  const contacted = built.filter((b) => b.lead.status !== 'new')
  const messages: schema.NewMessage[] = []
  const approver = users.find((u) => u.role === 'manager') ?? users[0]
  let cursor = 0

  const nextLead = (): BuiltCompany => {
    const item = contacted[cursor % contacted.length]
    cursor += 1
    if (item === undefined) throw new Error('no contacted leads to attach messages to')
    return item
  }

  // --- outbound ---
  for (const [status, count] of OUTBOUND_PLAN) {
    for (let n = 0; n < count; n += 1) {
      const target = nextLead()
      const index = messages.length
      const isWhatsapp = index % 5 === 4
      const sentAt =
        status === 'draft' || status === 'needs_input' || status === 'pending_approval'
          ? null
          : daysAgo(intBetween(rng, 1, 25))

      messages.push({
        id: id.message(index),
        workspaceId: id.workspace,
        leadId: target.lead.id ?? null,
        channel: isWhatsapp ? 'whatsapp' : 'email',
        direction: 'out',
        status,
        subject: isWhatsapp
          ? null
          : pick(rng, EMAIL_SUBJECTS).replace('{company}', target.company.name),
        body: (isWhatsapp ? WA_TEMPLATE_BODY : EMAIL_BODY_TEMPLATE)
          .replace(/\{name\}/g, target.contactName)
          .replace(/\{company\}/g, target.company.name)
          .replace(/\{industry\}/g, target.industry.toLowerCase())
          .replace(/\{city\}/g, target.city)
          .replace(/\{sender\}/g, 'Agus Pratama'),
        templateId: isWhatsapp ? 'perkenalan_pos_v1' : null,
        providerMessageId: sentAt === null ? null : `local-${index}`,
        threadId: `thread-${target.lead.id ?? index}`,
        scheduledAt: status === 'queued' ? daysAhead(1, 1) : null,
        sentAt,
        approvedBy:
          status === 'draft' || status === 'needs_input' || status === 'pending_approval'
            ? null
            : (approver?.id ?? null),
        rejectReason: null,
        idempotencyKey: sentAt === null ? null : `seed-out-${index}`,
        createdAt: sentAt ?? daysAgo(intBetween(rng, 0, 6)),
        updatedAt: sentAt ?? daysAgo(intBetween(rng, 0, 6)),
      })
    }
  }

  // --- inbound: one per classification label the reply reader must handle ---
  for (let n = 0; n < INBOUND_COUNT; n += 1) {
    const target = nextLead()
    const index = messages.length
    const reply = INBOUND_REPLIES[n % INBOUND_REPLIES.length]
    if (reply === undefined) throw new Error('INBOUND_REPLIES is empty')
    const receivedAt = daysAgo(intBetween(rng, 0, 12), n % 6)

    messages.push({
      id: id.message(index),
      workspaceId: id.workspace,
      leadId: target.lead.id ?? null,
      channel: n % 4 === 3 ? 'whatsapp' : 'email',
      direction: 'in',
      status: 'replied',
      subject: n % 4 === 3 ? null : `Re: Sistem kasir untuk ${target.company.name}`,
      body: reply.body,
      templateId: null,
      providerMessageId: `local-in-${index}`,
      threadId: `thread-${target.lead.id ?? index}`,
      scheduledAt: null,
      sentAt: receivedAt,
      approvedBy: null,
      rejectReason: null,
      idempotencyKey: `seed-in-${index}`,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    })
  }

  return messages
}

function buildActivities(rng: () => number, built: BuiltCompany[]): schema.NewActivity[] {
  const activities: schema.NewActivity[] = []

  for (let i = 0; i < ACTIVITY_COUNT; i += 1) {
    const target = built[i % built.length]
    if (target === undefined) throw new Error('no leads to attach activities to')
    const spec = ACTIVITY_TYPES[i % ACTIVITY_TYPES.length]
    if (spec === undefined) throw new Error('ACTIVITY_TYPES is empty')

    activities.push({
      id: id.activity(i),
      workspaceId: id.workspace,
      leadId: target.lead.id ?? null,
      type: spec.type,
      channel: spec.channel,
      actor: spec.actor,
      payload: {
        company: target.company.name,
        note:
          spec.type === 'status_changed'
            ? `Status diubah menjadi ${target.lead.status ?? 'new'}.`
            : spec.type === 'lead_scored'
              ? `Skor ${target.lead.score ?? 0} (${target.lead.category ?? 'cold'}).`
              : null,
      },
      createdAt: daysAgo(intBetween(rng, 0, 60), i % 8),
      updatedAt: daysAgo(intBetween(rng, 0, 60), i % 8),
    })
  }

  return activities
}

function buildSequenceRuns(
  rng: () => number,
  built: BuiltCompany[],
): schema.NewSequenceRun[] {
  const eligible = built.filter(
    (b) => b.lead.status !== 'new' && b.lead.status !== 'do_not_contact',
  )
  const runs: schema.NewSequenceRun[] = []

  for (let i = 0; i < SEQUENCE_RUN_COUNT; i += 1) {
    const target = eligible[i % eligible.length]
    if (target === undefined) throw new Error('no leads eligible for a sequence run')

    // SPEC §7 hard stops: a reply or a status at/after `interested` stops the run.
    const status = target.lead.status ?? 'new'
    const stopped =
      status === 'replied' ||
      status === 'interested' ||
      status === 'meeting' ||
      status === 'won' ||
      status === 'lost'
    const stopReason = stopped
      ? status === 'replied'
        ? 'replied'
        : status === 'meeting'
          ? 'meeting_booked'
          : status === 'lost'
            ? 'campaign_paused'
            : 'status_advanced'
      : null

    runs.push({
      id: id.sequenceRun(i),
      workspaceId: id.workspace,
      leadId: target.lead.id ?? '',
      sequenceId: 'default',
      currentStep: intBetween(rng, 1, 4),
      nextRunAt: stopped ? null : daysAhead(intBetween(rng, 0, 9), 1),
      state: stopped ? 'stopped' : i % 9 === 0 ? 'paused' : 'active',
      stopReason,
      createdAt: daysAgo(intBetween(rng, 10, 40)),
      updatedAt: daysAgo(intBetween(rng, 0, 9)),
    })
  }

  return runs
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const { publicEnv, serverEnv } = await import('../lib/env')
  const env = serverEnv()

  if (env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. This script deletes and rebuilds ' +
        `the "${WORKSPACE_SLUG}" workspace. Pass --force only if you truly mean it.`,
    )
  }

  const supabase = createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const users = await ensureUsers(supabase)

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })
  const db = drizzle(sql, { schema })

  try {
    const rng = createRng(20260820)

    // Rebuild from scratch. Deleting the workspace row cascades to every domain
    // table, which is why this is safe to re-run and why it only ever affects
    // the one workspace this script owns.
    await db.delete(schema.workspaces).where(eq(schema.workspaces.slug, WORKSPACE_SLUG))

    await db.insert(schema.workspaces).values({
      id: id.workspace,
      name: WORKSPACE_NAME,
      slug: WORKSPACE_SLUG,
      plan: 'pro',
      dailyEmailLimit: 200,
      dailyWaLimit: 100,
      autonomousMode: false,
      timezone: 'Asia/Jakarta',
    })

    await db.insert(schema.memberships).values(
      users.map((user) => ({
        id: uuidv5(`membership:${user.email}`),
        workspaceId: id.workspace,
        userId: user.id,
        role: user.role,
      })),
    )

    await db.insert(schema.products).values({
      id: id.product,
      workspaceId: id.workspace,
      name: 'Paket POS Kasir Pro',
      description:
        'Sistem kasir berbasis cloud untuk bisnis ritel dan F&B dengan banyak cabang. Mencakup manajemen stok, laporan penjualan harian, dan integrasi pembayaran QRIS.',
      valueProp:
        'Rekap penjualan seluruh cabang otomatis setiap malam, tanpa input manual dan tanpa selisih stok.',
      icp: {
        industries: ['Ritel', 'Makanan & Minuman'],
        size_bands: ['11-50', '51-200'],
        cities: ['Jakarta Selatan', 'Bandung', 'Surabaya', 'Semarang'],
        pain_points: [
          'Rekap penjualan antar cabang manual dan lambat',
          'Selisih stok antara catatan dan fisik',
          'Tidak ada laporan harian yang bisa dipercaya',
        ],
        min_outlets: 2,
      },
    })

    await db.insert(schema.knowledgeDocs).values([
      {
        id: id.knowledgeDoc('company_profile'),
        workspaceId: id.workspace,
        type: 'company_profile',
        title: 'Profil PT Maju Bersama Digital',
        content:
          'PT Maju Bersama Digital berdiri sejak 2019 di Jakarta Selatan. Kami membangun perangkat lunak kasir dan manajemen stok untuk bisnis ritel dan kuliner di Indonesia. Saat ini melayani lebih dari 400 outlet di 12 kota. Tim dukungan tersedia Senin sampai Sabtu, pukul 08.00-18.00 WIB.',
        isActive: true,
      },
      {
        id: id.knowledgeDoc('pricelist'),
        workspaceId: id.workspace,
        type: 'pricelist',
        title: 'Daftar Harga Paket POS 2026',
        content:
          'Paket Basic: Rp 299.000 per outlet per bulan, mencakup 1 perangkat kasir dan laporan harian. Paket Pro: Rp 599.000 per outlet per bulan, mencakup perangkat tanpa batas, manajemen stok, dan integrasi QRIS. Paket Enterprise: harga khusus, minimum 10 outlet. Semua harga belum termasuk PPN. Diskon tahunan 15 persen untuk pembayaran di muka.',
        isActive: true,
      },
      {
        id: id.knowledgeDoc('faq'),
        workspaceId: id.workspace,
        type: 'faq',
        title: 'FAQ Implementasi dan Dukungan',
        content:
          'Berapa lama implementasi? Rata-rata 5 hari kerja untuk 1-3 outlet. Apakah bisa offline? Ya, kasir tetap berjalan offline dan tersinkronisasi otomatis saat koneksi kembali. Apakah data bisa diekspor? Ya, dalam format CSV dan XLSX. Apakah ada biaya pemasangan? Tidak untuk paket Pro dan Enterprise.',
        isActive: true,
      },
    ])

    await db.insert(schema.integrations).values([
      {
        id: id.integration('gmail'),
        workspaceId: id.workspace,
        provider: 'gmail',
        status: 'connected',
        meta: { account: 'sales@majubersama.co.id', scopes: ['gmail.send', 'gmail.readonly'] },
      },
      {
        id: id.integration('whatsapp'),
        workspaceId: id.workspace,
        provider: 'whatsapp',
        status: 'disconnected',
        meta: { note: 'Menunggu verifikasi nomor bisnis.' },
      },
    ])

    const owner = users.find((u) => u.role === 'owner')
    const campaigns: schema.NewCampaign[] = [
      {
        id: id.campaign('pos-ritel-jabodetabek'),
        workspaceId: id.workspace,
        name: 'POS Ritel Jabodetabek Q3',
        productId: id.product,
        target: {
          industries: ['Ritel'],
          cities: ['Jakarta Selatan', 'Jakarta Pusat', 'Tangerang', 'Bekasi'],
          size_bands: ['11-50', '51-200'],
        },
        status: 'running',
        dailyCap: 40,
        createdBy: owner?.id ?? null,
        createdAt: daysAgo(45),
      },
      {
        id: id.campaign('fnb-jawa-timur'),
        workspaceId: id.workspace,
        name: 'F&B Jawa Timur',
        productId: id.product,
        target: {
          industries: ['Makanan & Minuman'],
          cities: ['Surabaya', 'Sidoarjo', 'Malang'],
          size_bands: ['1-10', '11-50'],
        },
        status: 'draft',
        dailyCap: 25,
        createdBy: owner?.id ?? null,
        createdAt: daysAgo(9),
      },
    ]
    await db.insert(schema.campaigns).values(campaigns)

    const campaignIds = campaigns.flatMap((c) => (c.id === undefined ? [] : [c.id]))
    const built = buildCompanies(rng, users, campaignIds)

    await db.insert(schema.companies).values(built.map((b) => b.company))
    await db.insert(schema.contacts).values(built.map((b) => b.contact))
    await db.insert(schema.leads).values(built.map((b) => b.lead))
    await db.insert(schema.activities).values(buildActivities(rng, built))
    await db.insert(schema.messages).values(buildMessages(rng, built, users))
    await db.insert(schema.sequenceRuns).values(buildSequenceRuns(rng, built))

    await db.insert(schema.suppressions).values([
      {
        id: id.suppression(0),
        workspaceId: id.workspace,
        kind: 'email',
        value: 'info@sinarabadi.co.id',
        reason: 'Balasan "jangan hubungi lagi"',
      },
      {
        id: id.suppression(1),
        workspaceId: id.workspace,
        kind: 'email',
        value: 'purchasing@karyamandiri.co.id',
        reason: 'Klik tautan berhenti berlangganan',
      },
      {
        id: id.suppression(2),
        workspaceId: id.workspace,
        kind: 'email',
        value: 'admin@grahapersada.co.id',
        reason: 'Hard bounce',
      },
      {
        id: id.suppression(3),
        workspaceId: id.workspace,
        kind: 'phone',
        value: '+628123456789',
        reason: 'Balasan STOP di WhatsApp',
      },
      {
        id: id.suppression(4),
        workspaceId: id.workspace,
        kind: 'domain',
        value: 'kompetitor.co.id',
        reason: 'Domain kompetitor, dikecualikan manual',
      },
    ])

    const agents = ['qualify', 'generate_content', 'classify_reply', 'enrich_company']
    await db.insert(schema.aiRuns).values(
      Array.from({ length: 12 }, (_, i) => {
        const ok = i % 7 !== 6
        return {
          id: id.aiRun(i),
          workspaceId: id.workspace,
          agent: agents[i % agents.length] ?? 'qualify',
          model: i % 5 === 4 ? 'gpt-4.1-mini' : 'gemini-2.5-flash',
          tokensIn: intBetween(rng, 400, 3200),
          tokensOut: intBetween(rng, 80, 900),
          costUsd: (intBetween(rng, 20, 900) / 100000).toFixed(6),
          latencyMs: intBetween(rng, 380, 4200),
          ok,
          error: ok ? null : 'Zod validation failed: missing field "confidence"',
          createdAt: daysAgo(intBetween(rng, 0, 20), i % 7),
        }
      }),
    )

    await db.insert(schema.webhookEvents).values([
      {
        id: id.webhookEvent(0),
        workspaceId: id.workspace,
        provider: 'n8n',
        idempotencyKey: 'run_20260812_090000',
        payload: { source: 'serper_places', items: 40 },
        processedAt: daysAgo(8),
      },
      {
        id: id.webhookEvent(1),
        workspaceId: id.workspace,
        provider: 'n8n',
        idempotencyKey: 'run_20260818_090000',
        payload: { source: 'serper_search', items: 20 },
        processedAt: daysAgo(2),
      },
      {
        id: id.webhookEvent(2),
        workspaceId: id.workspace,
        provider: 'gmail',
        idempotencyKey: 'history_884213',
        payload: { historyId: 884213 },
        processedAt: daysAgo(1),
      },
    ])

    // --- report ---
    const counts = await sql`
      select 'companies' as t, count(*) from companies where workspace_id = ${id.workspace}
      union all select 'contacts', count(*) from contacts where workspace_id = ${id.workspace}
      union all select 'leads', count(*) from leads where workspace_id = ${id.workspace}
      union all select 'activities', count(*) from activities where workspace_id = ${id.workspace}
      union all select 'messages', count(*) from messages where workspace_id = ${id.workspace}
      union all select 'sequence_runs', count(*) from sequence_runs where workspace_id = ${id.workspace}
    `
    console.log(`\nSeeded workspace "${WORKSPACE_NAME}" (/app/${WORKSPACE_SLUG})`)
    for (const row of counts) console.log(`  ${String(row.t).padEnd(14)} ${row.count}`)
    console.log('\nSign in as any of these at http://localhost:3000/login')
    for (const user of users) console.log(`  ${user.role.padEnd(8)} ${user.email}`)
    console.log('\nMagic-link emails are caught locally at http://127.0.0.1:54324')
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
