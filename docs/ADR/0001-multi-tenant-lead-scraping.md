# ADR 0001 — Multi-tenant lead scraping: plan in SORA, execute in n8n

- Status: accepted
- Date: 2026-09-20
- Deciders: owner, architect
- Supersedes: nothing. First ADR.

## Context

The lead hunter serves exactly one tenant today, and it does so by construction,
not by accident. Verified in the repository:

1. `n8n/workflows/sora-lead-hunter.json`, node **Search Plan**: `KEYWORDS` (12
   pet-shop terms) and `KOTA` (25 East Java locations) are literals in a Code
   node, and today's slice is `dayIndex % SLICES` counted from
   `START_DATE = '2026-09-07'`. The decision is made from the calendar, so it has
   no memory and no per-tenant identity. A second client handed "slice 3" gets a
   third of a space that is not theirs.
2. Node **SORA Config** sets one `campaign_id` from `$env.SORA_CAMPAIGN_ID`.
   One workflow, one campaign, one tenant.
3. `campaigns.target` (`src/lib/db/schema/crm.ts:87`) exists, is `jsonb`, is
   documented as "Target market definition handed to the lead hunter", and is
   read by **nothing** — `rg` finds it only in the schema file itself.
4. `workspaces.plan` (`free | pro | business`) is read once, as a label, at
   `src/app/app/[workspace]/settings/page.tsx:88`. Nothing enforces it.
5. There is no scraping meter of any kind.
6. `JUMLAH = 20` in the Search Plan node, with the comment "asking for more costs
   nothing". The comment is wrong: Serper charges 2 credits for 11–100 results
   and returns 10 regardless (`docs/PROGRESS.md:962-979`). Every sweep so far has
   cost double.

The goal is 10 tenants now, each in a different industry, potentially hundreds,
with **zero n8n edits per onboarding**.

Constraints taken as given: one Serper account for all tenants (clients never
hold a key); n8n stays the executor (pg-boss is named in CLAUDE.md §1 but is not
installed, and `src/app/api/cron/` does not exist — building either is a stack
question for the owner, not this ADR); `Loop Over Searches` is strictly
sequential at ~2–3 s per search, so **throughput, not Serper credits, is the
binding constraint**; ~830 searches/day covers 100 maintenance tenants, and ten
simultaneous onboardings (~2500/day, ~1.7 h) is the worst case to design for.

## Decision

SORA owns the decision. n8n becomes tenant-blind.

```
n8n (one workflow, forever)
  POST /api/webhooks/n8n/plan   (HMAC, same secret as the ingest route)
    -> { items: [ { campaign_id, idempotency_key, q, gl, hl, num, page } ] }
  for each item (sequential, as today)
      -> Serper
      -> POST /api/webhooks/n8n/leads   (unchanged route, campaign_id from the item)
```

`SORA_CAMPAIGN_ID` disappears from n8n. The only n8n configuration left is the
secret and the two URLs. Onboarding a client is: create the workspace, create the
campaign, write its `target`. No workflow edit.

### 1. `campaigns.target` — the shape (highest-value output)

`src/lib/scraping/target.ts`, pure. This shape is expensive to change once a
paying client exists, which is why it is fixed here before any code.

```ts
export const RESULTS_PER_REQUEST_MAX = 10   // 11-100 costs 2 Serper credits
export const MAX_SPACE_SIZE = 20_000        // keywords x locations x pages

export const searchTargetSchema = z
  .object({
    /** Bumped only when a field's meaning changes. Parsers switch on it. */
    version: z.literal(1),
    /** Which Serper endpoint. `places` is the only one wired today. */
    endpoint: z.enum(['places', 'search']).default('places'),
    /** What the tenant sells to, in the tenant's own words. Not industry codes. */
    keywords: z.array(z.string().trim().min(2).max(120)).min(1).max(60),
    /** Free text as a human would type it into Maps. Any country, any granularity. */
    locations: z.array(z.string().trim().min(2).max(120)).min(1).max(250),
    /** Serper `page`. The ONLY lever past 10 results for one query. */
    pages: z.array(z.int().min(1).max(10)).min(1).max(10),
    /**
     * Serper `num`. Capped at 10 in the type: 11 is the credit cliff, and a
     * value that doubles the bill must not be representable.
     */
    resultsPerRequest: z.int().min(1).max(RESULTS_PER_REQUEST_MAX).default(10),
    /** Serper `gl`. ISO-3166-1 alpha-2, lowercase. Not defaulted to 'id'. */
    country: z.string().regex(/^[a-z]{2}$/),
    /** Serper `hl`. BCP-47 primary subtag. */
    language: z.string().regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/),
    /** Optional note for the human who edits this. Never sent to Serper. */
    notes: z.string().max(500).optional(),
  })
  .refine(
    (t) => t.keywords.length * t.locations.length * t.pages.length <= MAX_SPACE_SIZE,
    { message: 'search space exceeds MAX_SPACE_SIZE' },
  )

export type SearchTarget = z.infer<typeof searchTargetSchema>
```

Deliberate properties:

- **Not Indonesia-specific and not pet-shop-specific.** `country` and `language`
  have no default; `keywords` and `locations` are free text so an FMCG tenant in
  Vietnam is expressible with no schema change.
- **`resultsPerRequest` maxes at 10 in the type, not in a comment.** The bug in
  point 6 above cannot be re-introduced by editing a literal.
- **`version: 1` is required**, so a future v2 is a discriminated parse, not a
  guess about which rows are old.
- **The space size is bounded at parse time**, so a tenant cannot author a space
  that takes four years to walk and discover it from a dashboard.
- **No `industry`, `size` or `budget` field.** `products.icp` already holds the
  ideal-customer profile and the scoring rubric reads it. `target` answers "what
  do we type into Serper", nothing else. One field, one job.

Invalid or absent `target` → the campaign contributes zero items and appears in
`skipped` with reason `invalid_target`. It is never an exception.

### 2. The search space and the cursor

**Enumeration is a pure function of the target.** `buildSearchSpace(target)`
returns a deterministic, stable-ordered `SearchItem[]`:

1. Canonicalise: trim, collapse internal whitespace, lowercase `country` and
   `language`, sort `keywords` and `locations` (locale-independent codepoint
   sort), sort and dedupe `pages`.
2. Enumerate **page-major ascending** — every page-1 combination before any
   page-2 combination. Page 1 is the highest yield per credit, so a tenant's
   first days buy the most.
3. Within a page block, apply a **stride permutation**: element `j` of the block
   is lexicographic element `(j * stride) % blockSize`, where `stride` is the
   smallest prime > `sqrt(blockSize)` that is coprime with `blockSize`. Coprime
   ⇒ it is a bijection ⇒ a contiguous window is a *mix* of keywords and cities,
   which is what `i % SLICES` achieved accidentally today and what a contiguous
   cursor window would otherwise lose.

`composeQuery(keyword, location)` builds the final `q` string. SORA sends the
composed query; n8n no longer concatenates anything.

**The cursor lives in a new table `scrape_cursors`, one row per campaign**, not
in columns on `campaigns`. Reasons: most campaigns (CSV import, manual) have
`target = null` and would carry six permanently-null runtime columns; the row is
written daily by the service-role planner and read by nothing a user edits, so
its RLS grant can be SELECT-only while `campaigns` stays read-write; and
`(position, space_fingerprint)` is one atomic invariant — "this index is only
meaningful for this space" — which is easier to enforce, reset and delete as a
row than as a set of columns somebody must remember to null together.

**What workspace X searches today**, exactly:

1. Load every campaign with `status = 'running'` and `target is not null`, joined
   to its workspace and its cursor.
2. `parseTarget(campaign.target)`. Failure → skip, reason `invalid_target`.
3. `fingerprint = sha256(JSON.stringify(canonicalize(target)))`. If there is no
   cursor, or `fingerprint !== cursor.space_fingerprint`, the cursor resets:
   `position = 0`, `lap = 0`, new fingerprint, new `space_size`. **Editing the
   target restarts the space.** An index into a space that no longer exists is
   meaningless, and silently keeping it would sweep the wrong combinations.
4. Quota gate (§4). `remaining <= 0` or lapsed subscription → contributes zero,
   reason `quota_exhausted` / `subscription_lapsed`. Not an error path.
5. Tier → desired daily volume (§3).
6. Global smoothing against the day's budget (§3).
7. Emit `allocation` items starting at `position`, wrapping modulo `space_size`;
   a wrap increments `lap`.
8. In one transaction: update the cursor (`position`, `lap`, `last_planned_on`,
   `tier`) and insert one `scrape_runs` row carrying the issued window.

### 3. Tiers, budget and smoothing — all pure

`src/lib/scraping/allocate.ts`. Constants, exported and named so a change is a
reviewable diff:

```ts
export const DAILY_SEARCH_BUDGET = 2500  // ~1.7h sequential at 2.5s/search
export const TIER_DAYS = { burst: 5, steady: 30, maintenance: 90 } as const
export const MIN_BATCH = 10
export const MAX_BATCH_PER_CAMPAIGN = 400
export const FIRST_LAP_MULTIPLIER = 3
export const TIER_WEIGHT = { burst: 3, steady: 2, maintenance: 1 } as const
export const TIER_SAMPLE_MIN = 50
export const TIER_COOLDOWN_DAYS = 7
```

**Tier** (`classifyTier`, pure) uses the saturation signal `scripts/lead-stats.ts`
already measures — `new` falling while `merged` climbs:

- `lap === 0` → `burst`. The space has never been walked once.
- `newLast14 + mergedLast14 < TIER_SAMPLE_MIN` → keep the current tier. Too
  little evidence; a quiet week is not saturation.
- `newLast14 / (newLast14 + mergedLast14) >= 0.25` → `steady`.
- otherwise → `maintenance`. The ground is covered; a lap every 90 days catches
  businesses that opened since.
- A tier may not change more than once per `TIER_COOLDOWN_DAYS`
  (`tier_changed_on`), so it cannot flap.

**Desired volume per campaign**, in this order:

```
tierDesired = ceil(spaceSize / TIER_DAYS[tier])
pace        = ceil(quotaRemaining / daysLeftInMonth) * (lap === 0 ? FIRST_LAP_MULTIPLIER : 1)
desired     = min(tierDesired, max(MIN_BATCH, pace), MAX_BATCH_PER_CAMPAIGN, quotaRemaining)
```

`pace` is what makes a non-zero trial quota actually demo-able: a trial (300/month)
gets ~30 searches on day one rather than 10, front-loads for about ten days, and
then goes quiet — which is the intended sales behaviour, not a bug.

**Smoothing.** If `Σ desired <= budget`, everyone gets what they asked for.
Otherwise allocate `budget * (w_i * desired_i) / Σ(w_j * desired_j)`, floor it,
then hand out the remainder by largest fractional part with ties broken by
`campaign_id` — deterministic, so the unit suite can assert exact numbers. Then
enforce a floor of `MIN_BATCH` for as many campaigns as still fit, in
`(last_planned_on asc nulls first, campaign_id)` order. That ordering is the
anti-starvation rule: a campaign squeezed out today is first in line tomorrow,
using state the cursor already keeps.

Worked example the engineer should turn into a test. Ten tenants onboard the same
day, each with a 12 × 25 × 5 = 1500 space. `tierDesired = 300` each,
`Σ desired = 3000 > 2500`. Equal weights ⇒ each gets 250. Burst completes in 6
days instead of 5 and nothing is dropped. Add a hundredth tenant in maintenance
(`ceil(1500/90) = 17`) and it still gets its 17.

### 4. Plan, quota and metering

**The plan enum.** Existing `workspace_plan` is `free | pro | business`; the
owner's numbers are trial 300, starter 1500, pro 5000, business 15000. Decision:
**extend the enum with `trial` and `starter` (ADD VALUE only), and put the
numbers in columns on `workspaces`** — not in an enum-to-number map in code, and
not in a separate entitlements table.

- The enum is extended because a label that says "free" to a paying starter
  client is a lie in the UI, and `ALTER TYPE ... ADD VALUE` is cheap and
  non-destructive. `free` is **retained**, not removed — Postgres cannot drop an
  enum value without recreating the type — and marked deprecated in place. New
  workspaces default to `trial`. `PLAN_LABELS` in `src/components/crm/labels.tsx`
  gains the two keys; it is already `Record<string, string>`, so nothing breaks.
- The numbers are columns because they are commercial and the owner called them
  indicative. A quota change must be a row update a human makes, not a migration
  and a deploy. A negotiated per-client quota ("this one gets 3000") is inevitable
  at ten clients and cannot be expressed by an enum at all. And "subscription
  lapsed" is a date, not an enum value.
- They go on `workspaces` rather than in a new table because the two quota
  columns beside them — `daily_email_limit`, `daily_wa_limit` — are already
  exactly this, and `.claude/rules/data.md` says the answer is often a column on
  a table that already exists.

```ts
// src/lib/db/schema/workspace.ts — added to `workspaces`
monthlySearchQuota: integer('monthly_search_quota').notNull().default(300),
subscriptionValidUntil: timestamp('subscription_valid_until', { withTimezone: true }),
```

`PLAN_DEFAULTS` in `src/lib/scraping/quota.ts` maps plan → quota and is used
**only** when provisioning a workspace or changing its plan, to write the column.
The allocator reads the column and never the map. One authority at read time.

**Security finding this forces.** `drizzle/0001_rls.sql:88` grants
`workspaces_update_owner` FOR UPDATE to the owner role, and
`drizzle/0003_rls_domain.sql:47` grants UPDATE on `workspaces` to `authenticated`.
An owner can therefore already `update workspaces set plan = 'business'` through
PostgREST with the anon key. Adding a quota column would make that cost real
money. The RLS migration for this ADR must include column-level revokes:

```sql
REVOKE UPDATE (plan, monthly_search_quota, subscription_valid_until)
  ON "workspaces" FROM authenticated;
```

Recommended in the same statement: `daily_email_limit`, `daily_wa_limit`. The
settings screen renders them read-only today, so nothing in the product breaks.

**Metering: `scrape_runs`, modelled on `ai_runs`.** One row per campaign per plan
date. `numeric(12,6)` for cost for the reason `ai_runs.cost_usd` gives — costs get
summed for billing and must not drift.

```
scrape_runs
  id                uuid pk default gen_random_uuid()
  workspace_id      uuid not null -> workspaces(id) on delete cascade
  campaign_id       uuid null     -> campaigns(id)  on delete SET NULL
  plan_date         date not null            -- bucketed in the workspace timezone
  provider          text not null default 'serper_places'
  space_fingerprint text not null
  issued_from       integer not null         -- cursor position at issue
  issued_count      integer not null         -- searches handed out
  credits           integer not null         -- = issued_count while num <= 10
  cost_usd          numeric(12,6)
  executed_count    integer not null default 0   -- reconciled at ingest, phase 2
  results_count     integer not null default 0   -- reconciled at ingest, phase 2
  ok                boolean not null default true
  error             text
  created_at, updated_at  timestamptz not null default now()

  unique (campaign_id, plan_date) where campaign_id is not null
  index  (workspace_id, plan_date desc)
```

- `campaign_id` is `SET NULL`, not `CASCADE`: deleting a campaign must not erase
  the month's metered spend. The unique index is partial for the same reason,
  following the `companies_workspace_domain_key` precedent.
- The unique index **is** the plan endpoint's idempotency: a second call for the
  same `(campaign, plan_date)` re-reads the row and re-issues the identical
  window `[issued_from, issued_from + issued_count)` instead of advancing.
- **Quota is consumed at issue, not at execution.** `remaining = monthly_search_quota
  - sum(credits) over the current month in the workspace's timezone`, served by
  `(workspace_id, plan_date desc)`. Charging at issue is the conservative
  direction and is what actually protects the Serper account; reconciliation
  (`executed_count`) is observability, and is phase 2.

```
scrape_cursors
  id                uuid pk default gen_random_uuid()
  workspace_id      uuid not null -> workspaces(id) on delete cascade
  campaign_id       uuid not null -> campaigns(id)  on delete cascade
  space_fingerprint text not null
  space_size        integer not null
  position          integer not null default 0     -- next index to issue
  lap               integer not null default 0     -- completed full passes
  lap_started_on    date not null
  last_planned_on   date                           -- rotation key for the smoother
  tier              scrape_tier not null default 'burst'
  tier_changed_on   date
  created_at, updated_at  timestamptz not null default now()

  unique (campaign_id)
  index  (workspace_id)
```

`scrape_tier` is a new pgEnum: `burst | steady | maintenance`. `last_planned_on`
is a denormalisation of `max(scrape_runs.plan_date)`, kept because the allocator
sorts every candidate by it on every run.

**Schema file.** Both tables go in a new `src/lib/db/schema/scraping.ts`, exported
from the barrel after `crm`. `scrape_cursors` references `campaigns`, so the file
sits at `workspace ← crm ← scraping` — a sibling of `outreach`, acyclic, nothing
in `crm` or `outreach` imports it. They do not go in `crm.ts` because scraping
runtime state is not the CRM chain, and `ai.ts` is the precedent for giving a
machine-observability table its own file.

**RLS** (hand-written migration, since drizzle-kit emits none):

```sql
ALTER TABLE "scrape_cursors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scrape_cursors" FORCE ROW LEVEL SECURITY;
GRANT SELECT ON "scrape_cursors" TO authenticated;
CREATE POLICY "scrape_cursors_member_read" ON "scrape_cursors"
  FOR SELECT TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"));
-- identically for "scrape_runs" -> "scrape_runs_member_read"
```

This deviates from the uniform `_member_all` pattern in `0003_rls_domain.sql`
deliberately and in the restrictive direction: both tables are machine state
written only through the service-role path, a member must be able to *see* their
coverage and their bill, and nobody may forge either. Workspace deletion still
cascades, so the UU PDP deletion obligation is met without a DELETE grant. The
deviation must be stated in the PR body, per `.claude/rules/data.md`.

### 5. The plan endpoint

`src/app/api/webhooks/n8n/plan/route.ts`, `runtime = 'nodejs'`. Auth mirrors
`src/app/api/webhooks/n8n/leads/route.ts` exactly: read the **raw** body, HMAC-
SHA256 it with `N8N_WEBHOOK_SECRET`, compare with `timingSafeEqual` against
`x-sora-signature: sha256=<hex>`, **then** parse. Same secret — same consumer,
same trust boundary; do not add `N8N_PLAN_SECRET`. The shared verifier should be
lifted to `src/lib/webhooks/signature.ts` when the second caller lands, which is
now.

It is a POST although it reads, because it mutates the cursor and because an
HMAC over the raw body needs a body to sign. It lives beside `leads/` rather than
under `api/cron/` because the caller is n8n and the contract is the n8n contract;
`.claude/rules/structure.md` gains one line for it.

```ts
const planRequestSchema = z.object({
  idempotency_key: z.string().min(1).max(200),
  /** Defaults to the server's today. Explicit for replay and for tests. */
  plan_date: z.iso.date().optional(),
  /** Throughput the executor will accept today. Server takes min(this, budget). */
  max_items: z.int().min(1).max(5000).optional(),
  /** Compute and return without advancing any cursor or metering anything. */
  dry_run: z.boolean().default(false),
})

const planItemSchema = z.object({
  campaign_id: z.uuid(),
  /** Echoed verbatim into the ingest POST. Deterministic per (campaign, date, index). */
  idempotency_key: z.string().min(1).max(200),
  /** Fully composed. n8n concatenates nothing. */
  q: z.string().min(1).max(500),
  gl: z.string().regex(/^[a-z]{2}$/),
  hl: z.string().min(2).max(10),
  num: z.int().min(1).max(10),
  page: z.int().min(1).max(10),
  endpoint: z.enum(['places', 'search']),
  /** So n8n can report the window back without parsing the key. */
  space_index: z.int().min(0),
  plan_date: z.iso.date(),
})

const planResponseSchema = z.object({
  plan_date: z.iso.date(),
  generated_at: z.iso.datetime(),
  budget: z.int(),
  item_count: z.int(),
  items: z.array(planItemSchema),
  skipped: z.array(
    z.object({
      campaign_id: z.uuid(),
      reason: z.enum([
        'quota_exhausted',
        'subscription_lapsed',
        'invalid_target',
        'already_planned',
        'no_budget',
      ]),
    }),
  ),
  replayed: z.boolean(),
})
```

`skipped` is part of the contract, not debug output: it is how the owner sees
"client X contributed nothing today, and why" without reading logs. A workspace
out of quota produces a `skipped` entry and a 200, never a 4xx.

Errors are English machine codes, as in the ingest route — the consumer is n8n,
not a person, so rule 8 does not apply: `invalid_signature` 401, `invalid_json`
400, `invalid_payload` 422.

**Ingest route change — additive, not a redesign.** `payloadSchema` gains one
optional field so phase-2 reconciliation has something to key on:

```ts
plan: z.object({ plan_date: z.iso.date(), space_index: z.int().min(0) }).optional()
```

CSV and manual posts omit it. Nothing else in that file moves.

### 6. Module map and the pure/IO boundary

```
src/app/api/webhooks/n8n/plan/route.ts   HMAC + Zod + serialise      (IO)
  -> src/lib/scraping/plan.ts            orchestrate, one tx, Result (IO)
       -> src/lib/scraping/context.ts    load candidates             (IO)
       -> src/lib/scraping/allocate.ts   the whole decision          (PURE)
            -> src/lib/scraping/target.ts schema, space, query       (PURE)
       -> src/lib/scraping/quota.ts      PLAN_DEFAULTS, month window (PURE)
src/lib/db/queries/scraping.ts           usage panel for the UI      (IO, ws-scoped)
src/lib/db/schema/scraping.ts            tables
```

Call direction is one-way. `allocate.ts` and `target.ts` must not import
`context.ts`, `plan.ts`, the Drizzle handle, or `Date.now()` — the current date
is a parameter. This is the same split as `send-guard.ts` / `send-context.ts` and
for the same stated reason: a file that imports the Drizzle handle cannot be
imported by a test with no `DATABASE_URL`.

Pure and therefore unit-testable with no database:

| Function | File | Carries |
|---|---|---|
| `searchTargetSchema`, `parseTarget` | `target.ts` | the contract with every paying client |
| `canonicalizeTarget`, `fingerprintTarget` | `target.ts` | cursor validity |
| `buildSearchSpace`, `takeWindow`, `composeQuery` | `target.ts` | what actually gets searched |
| `classifyTier` | `allocate.ts` | burst vs. maintenance spend |
| `allocatePlan` | `allocate.ts` | the budget, fairness, the quota gate |
| `planItemIdempotencyKey` | `allocate.ts` | replay safety |
| `monthWindow`, `remainingQuota`, `PLAN_DEFAULTS` | `quota.ts` | the bill |

I/O, not unit-tested: `context.ts` (one cross-tenant read), `plan.ts` (the
transaction), the route (signature and serialisation), `queries/scraping.ts`.

**The one deliberate cross-workspace query.** `context.ts` reads campaigns across
all tenants in a single pass — the same exception, for the same reason, as
`leads_next_action_at_idx` ("the follow-up runner sweeps due leads across all
workspaces in one pass, then fans out per workspace"). It is bounded by three
rules: it selects only `(campaign_id, workspace_id, target, plan, quota,
valid_until, timezone, cursor fields)` and never touches a lead, contact or
message; every write is keyed by the `workspace_id` carried on the row it came
from; and the ingest path re-resolves the workspace from `campaign_id` itself, so
a wrong `campaign_id` in a plan item writes nowhere rather than writing to the
wrong tenant. `src/lib/db/queries/scraping.ts`, which serves the UI, filters
`workspace_id` like everything else.

### 7. Migrations

1. `pnpm db:generate` — `scrape_tier` enum, `scrape_cursors`, `scrape_runs`, the
   two new `workspaces` columns, and `ALTER TYPE workspace_plan ADD VALUE
   'trial' / 'starter'`.
   **Trap:** Postgres cannot *use* an enum value added in the same transaction
   that adds it, and drizzle-kit runs a migration in one transaction. Adding the
   values and setting `default 'trial'` in one file will fail with "unsafe use of
   new value". Split: this migration adds the values only.
2. `drizzle/00NN+1_rls_scraping.sql`, hand-written — enable/force RLS, the two
   SELECT grants and policies, and the `REVOKE UPDATE (...)` on `workspaces`.
3. `drizzle/00NN+2_plan_default_and_target.sql` — set the `workspace_plan`
   default to `'trial'`, backfill `monthly_search_quota` from the current plan,
   and write `campaigns.target` for the existing `data-riil` campaign from the
   literals now in the Search Plan node. Seed its cursor with `lap = 1` so
   `classifyTier` measures its real saturation instead of bursting back over
   ground already swept.

`scripts/seed.ts` gains a second workspace in a different industry — the cheapest
proof that nothing is pet-shop-shaped — each with a target, a cursor and a few
`scrape_runs` rows so the usage panel is demo-able. `plan_date` must be derived
from a fixed date, never `now()`, or the deterministic-count property breaks.

**No new dependency.** `zod`, `drizzle-orm` and `node:crypto` are already here.

## Alternatives considered

**Keep the plan in n8n and make the Code node tenant-aware** — have it fetch all
campaigns and compute slices in JavaScript. Rejected because the quota gate would
then live in n8n, and a non-paying client would keep being swept until a human
remembered to edit a workflow; because none of that logic is testable by
`pnpm test`; and because the cursor would still have nowhere to live.

**One row per search in a `scrape_jobs` queue table.** Rejected: it is a queue,
and the queue named in CLAUDE.md §1 is pg-boss, which is not installed —
hand-rolling a second one is a stack decision, not an architectural one. It also
buys nothing today: n8n's loop is already the sequencer, and per-search rows are
~300k/year for observability the per-day row gives at 1/800th the volume.

**A `workspace_entitlements` table instead of columns.** Rejected because
`daily_email_limit` and `daily_wa_limit` already establish that a tenant quota is
a column on `workspaces`, and a second home for tenant configuration fragments it
for no gain. The privilege-escalation risk that motivated the table is better
answered by the column-level `REVOKE`, which also closes the pre-existing hole on
`plan` that a new table would have left open.

**Mapping the four quota names onto the existing three enum values.** Rejected:
a starter client whose settings screen says "free" is a lie in the product, and
the mapping would have to be remembered in two places forever.

## Consequences

- Onboarding a client is three database writes and no n8n edit. That is the whole
  point of the ADR and the thing to regression-test first.
- Each tenant walks its own space from its own day zero. The calendar modulo, and
  `START_DATE`, are deleted.
- Serper spend halves the day `resultsPerRequest` ships at 10, independently of
  everything else here.
- The system degrades by *contributing less*, never by erroring: out of quota,
  lapsed, invalid target and no budget are all `skipped` entries on a 200.
- One workspace cannot starve another: `MAX_BATCH_PER_CAMPAIGN` caps a single
  burst and the rotation key guarantees a squeezed-out campaign goes first
  tomorrow.
- **Re-running a partially executed day costs Serper credits again.** The plan
  re-issues the identical window, n8n re-searches, and the ingest route correctly
  inserts nothing. Credits are spent for work already done. Phase-2
  reconciliation (`executed_count`) is what would let the re-issue return only
  the unexecuted tail. Accepted for now; it is a cost, not a correctness bug.
- **Quota is charged at issue.** If n8n never runs, the tenant is billed for
  searches that never happened until reconciliation lands. Conservative in the
  direction that protects the Serper account, wrong in the direction that annoys
  a client. Watch `issued_count` vs `executed_count` once phase 2 exists.
- The decision logic is in TypeScript under `pnpm test`, so replacing n8n later —
  with pg-boss or anything else — is a change of executor only: the same
  `allocatePlan` output feeds it. That migration is deliberately kept cheap. It
  is **not** proposed here; it is a stack question for the owner.

## Risks, and which of them a test catches

| Risk | Caught by |
|---|---|
| Target edited, cursor keeps indexing the old space | unit: `fingerprintTarget` differs ⇒ `allocatePlan` emits from index 0 |
| The space permutation skips or repeats combinations | unit: the first `N` items of a size-`N` space are exactly the `N` distinct combinations |
| A day's plan exceeds the throughput budget | unit: `Σ allocation <= min(budget, max_items)` over generated inputs |
| A small tenant starves under a tight budget | unit: 30 campaigns, budget 100 — every campaign is planned at least once within 3 simulated days |
| An out-of-quota or lapsed workspace still gets swept | unit on `allocatePlan`; integration on the endpoint |
| `num > 10` silently doubles the bill again | unit: every emitted item has `num <= 10`; the Zod `.max(10)` makes it unrepresentable |
| The plan is issued twice for one day | integration: two POSTs return identical `items`, `replayed: true`, cursor unmoved; `unique (campaign_id, plan_date)` |
| Cross-tenant leak in the one unscoped query | integration: plan items reference only running campaigns, and a member's Supabase-client read of `scrape_runs` returns only their own |
| An owner raises their own quota or plan via PostgREST | integration, as an owner JWT: `update workspaces set plan='business'` and `set monthly_search_quota=...` both fail |
| Month boundary computed in UTC, not the workspace timezone | unit on `monthWindow` at `2026-10-01T00:30+07:00` |
| `ALTER TYPE ... ADD VALUE` used in its own transaction | **not** caught by any unit test — only by `pnpm db:reset` / a migration run in CI. Stated here because it will otherwise be found in production |
| n8n dies mid-sweep; the day looks paid-for and empty | nothing catches it until phase-2 `executed_count`. `pnpm leads:stats` shows the zero day |

## Handed straight to the engineer, no further design needed

- `JUMLAH = 20` → `10` in the Search Plan node. One word, halves the Serper bill,
  independent of everything above. Ship it now, do not wait for this ADR.
- Lifting the HMAC verifier out of the ingest route into
  `src/lib/webhooks/signature.ts`. Pure move, no decision in it.
- The two new `PLAN_LABELS` keys in `src/components/crm/labels.tsx`.
