# SORA — Progress

Current state and next steps. Updated after every task, per CLAUDE.md §4.

**Last updated:** 2026-08-26 (fourth pass: slice 3a shipped)
**Phase:** 2 in progress — Module 1, lead ingestion. Slice 3a (webhook + dedupe)
is done and green; 3b (CSV upload) and 3c (enrichment worker) are next.

---

## Where we are

The database is real. Every domain table from `docs/SPEC.md` exists, is
protected by RLS, and is filled by a deterministic seed, so the product can be
demoed end to end without a single external service. All nine module screens now
read live data — the Phase 0 placeholders are gone. No business logic (ingestion,
scoring, generation, sending) exists yet: every screen is read-only, and nothing
in the product can create, edit, approve, or send anything.

| Gate | Status |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ clean, 0 errors 0 warnings |
| `pnpm test` | ✅ 99 tests, 3 files |
| `pnpm build` | ✅ **all 17 routes built** — previously blocked, now closed |
| `pnpm test:integration` | ✅ **46 tests, 3 files** — 24 of them new in slice 3a |
| `pnpm test:e2e` | ⏸️ written, not run — Playwright browsers still not installed |

All six gates were run on 2026-08-26 against the live local stack. Five are green;
the sixth is a deliberate deferral, not a failure.

**The machine is unblocked.** Docker Desktop is installed and the Supabase stack
runs locally: 10 containers, Postgres 17 healthy, migrations `0000`–`0003` applied,
seed loaded. `.env.local` is complete. The two long-standing environment blockers
are closed, and with them the last doubt about the `src/` move — `next build` now
completes end to end, all 17 routes.

The integration suite running for the first time matters more than the build. RLS
isolation, the privileged-connection bypass, and every seed invariant are now
**proven against real Postgres** rather than asserted in a document.

---

## Done

### Tooling
- Next.js **15.5.23** (App Router, RSC by default), React 19.2.8, TypeScript
  `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
- Tailwind v4 + shadcn/ui (new-york, neutral), generated into `src/components/ui/`
  and treated as vendor code. `badge`, `card`, `table` added in this phase.
- ESLint flat config. `no-explicit-any`, `no-non-null-assertion`, and
  `consistent-type-assertions: never` are **errors** on our code — CLAUDE.md
  rule 9 is enforced by the linter, not by review. `src/components/ui/**` and the
  Supabase CLI scratch directories are exempt.
- Vitest runs two suites: `tests/unit` (pure, default config) and
  `tests/integration` (real Postgres, `vitest.integration.config.ts`, file
  parallelism off because the seed rebuilds a shared workspace).

### Environment (rule 1)
- `src/lib/env.ts` is the only file in the codebase that reads `process.env`.
  The single exception is `instrumentation.ts` reading `NEXT_RUNTIME`, a Next
  runtime discriminator, not app config.
- `instrumentation.ts` calls `serverEnv()` in `register()`, so a missing
  variable kills the process **at boot**.
- `.env.local` points at the local Supabase stack using the **new** Supabase key
  format: `sb_publishable_…` replaces the anon JWT, `sb_secret_…` replaces the
  service_role JWT. Variable names are unchanged — only the value shape is.
  `src/lib/env.ts` needed no edit for this: it validates both keys as
  `z.string().min(1)`, never as a JWT, so neither format is privileged. Values
  are only ever valid against 127.0.0.1.
- Optional integration vars are **commented out**, never set to `""`.
  `z.string().min(1).optional()` accepts `undefined` but rejects the empty
  string, and dotenv loads `FOO=""` as `''` — so a blank placeholder crashes
  `serverEnv()` at boot. `.env.example` shipped exactly that trap (it told the
  reader to copy it and fill in `""` placeholders); both files now comment the
  line out instead. See decision 11.

### Local database
- Supabase CLI added as a dev dependency; `supabase/config.toml` committed.
- `pnpm db:start` / `db:stop` / `db:reset` (reset = recreate, migrate, seed).
- Migrations `0000`–`0003` have been applied against it. The Phase 0 blocker
  "no database has been touched" is closed.

### Schema
- `src/lib/db/schema.ts` split into `src/lib/db/schema/` — `workspace.ts`, `crm.ts`,
  `outreach.ts`, `ai.ts`, re-exported from `index.ts`. `drizzle.config.ts`
  points at the directory.
- 15 tables: `workspaces`, `memberships`, `products`, `knowledge_docs`,
  `integrations`, `companies`, `contacts`, `leads`, `activities`, `campaigns`,
  `messages`, `sequence_runs`, `suppressions`, `ai_runs`, `webhook_events`.
  Every domain table carries `workspace_id` (rule 6).
- `drizzle/0002_equal_whistler.sql` — generated tables and enums.
- `drizzle/0003_rls_domain.sql` — hand-written: FKs to `auth.users`
  (`ON DELETE SET NULL`, so losing a salesperson never deletes their leads),
  explicit grants to `authenticated`, and 13 policies. RLS is enabled **and
  forced** on every table. Policies are written out per table rather than
  generated in a loop, so grepping for a table name shows the policy guarding
  it. `is_workspace_member()` from `0001_rls.sql` keeps the `memberships`
  policy from recursing through itself.

### Seed
- `scripts/seed.ts` (row builders) + `scripts/seed-data.ts` (Indonesian
  vocabulary, templates, scoring bands). Deterministic — UUIDv5 from a fixed
  namespace and a seeded RNG — and **idempotent**, asserted by a test.
- Workspace `maju-bersama` (PT Maju Bersama Digital), three real Supabase auth
  users pre-confirmed as owner / manager / sales.
- 60 companies + 60 contacts + 60 leads covering every lead status, scores
  spread across the SPEC hot/warm/cold bands, `score_factors` that sum to the
  stored score, and reasons written in Bahasa Indonesia.
- 90 messages (drafts waiting in approvals, replies waiting in the inbox),
  150 activities, 25 sequence runs, 5 suppressions, 12 `ai_runs`,
  3 `webhook_events`, 2 campaigns, 1 product, 3 knowledge docs, 2 integrations.
- Phones are stored canonical E.164 with the scraped `08xx` form kept in `raw`.

### Query layer
- `src/lib/db/queries/dashboard.ts` — stats, funnel, due-lead queue, recent
  activities, pending approvals, new leads this month.
- `src/lib/db/queries/records.ts` — list functions for leads, companies, contacts,
  campaigns, inbox, approvals, knowledge docs, members, integrations,
  suppressions, product count.
- Every function takes `workspaceId` and filters on it. This is load-bearing,
  not stylistic: Drizzle connects privileged and bypasses RLS (known issue 1).

### UI
- Dashboard reads live data: stat cards, funnel, due-lead queue with overdue
  marking, recent activity feed, pending approval count.
- Leads list reads live data: table with status and score-category badges.
- The other seven screens are wired to `src/lib/db/queries/records.ts`, all following
  the Leads shape (`getWorkspaceContext` → `notFound()` → query → empty state or
  table, inside `overflow-x-auto` with columns dropped at `sm`/`md`/`lg`):
  Perusahaan, Kontak and Kampanye are tables; Kotak Masuk and Persetujuan are
  card lists; Basis Pengetahuan groups documents under type headings; Pengaturan
  is sections rather than one table.
- Persetujuan surfaces the query's `needs_input`-first ordering as a banner
  counting drafts the AI could not complete from `knowledge_docs` (rule 3), and
  says plainly that approve/reject arrives with Modul 5.
- Pengaturan shows workspace identity, sending limits, `autonomousMode` (marked
  non-aktif and explicitly not wired to skip approval, rule 5), members,
  integrations and suppressions.
- `src/lib/auth/members.ts` joins `memberships` to Supabase Auth: `memberships`
  stores only `user_id`, so `listMembersWithEmail()` resolves emails through
  `src/lib/db/admin.ts`. Allowed under rule 6 — `admin.ts` is `server-only` and the
  caller renders under the authed workspace layout. Degrades to `email: null`
  rather than throwing when the auth call fails.
- `src/components/layout/module-placeholder.tsx` deleted; nothing imported it once
  the last screen was wired.
- `src/components/crm/labels.tsx` holds the shared Indonesian labels and badges
  (lead status, activity type, actor, score category). `src/lib/format.ts` holds
  number/date/percent formatting and `isOverdue`.
- Sidebar (9 sections) + topbar with workspace switcher and user menu; collapses
  to icons on desktop, to a sheet on mobile. All copy is Bahasa Indonesia; route
  slugs stay English. The seven unwired pages keep their designed empty state.

### Auth
- Supabase magic link. Server action → `signInWithOtp` → `/auth/callback`
  exchanges the PKCE code → redirects to `?next=`.
- `?next=` accepts relative paths only, checked in three places. No open
  redirect.
- `middleware.ts` matches `/app/:path*`, refreshes the session with `getUser()`
  (not `getSession()` — that trusts the cookie), and redirects signed-out users
  to `/login?next=…` carrying refreshed cookies through.
- `src/app/app/[workspace]/layout.tsx` does the membership check. A non-member and a
  non-existent slug both get the same `notFound()`, so slugs cannot be probed.

### Tests
- `tests/integration/rls.test.ts` — asserts RLS is enabled, forced, and policied
  on every table in `public`, cross-checked against the live catalogue so a new
  unlisted table fails the suite. Then, under `SET LOCAL ROLE authenticated`,
  proves cross-workspace reads, updates, deletes, inserts, and
  workspace-relabelling are all denied, symmetrically, and that a user with no
  membership sees nothing. One test documents that the privileged connection
  bypasses RLS on purpose.
- `tests/integration/seed.test.ts` — row counts per table, the three roles as
  real auth users, every lead status present, score bands, `score_factors`
  summing to the score, Indonesian reasons, E.164 phones, drafts and replies in
  the right queues, and a second run changing nothing.

### Structure and harness (2026-08-24, no product change)

- **Application code moved into `src/`.** `app/`, `components/`, `lib/`, `hooks/`,
  `middleware.ts` and `instrumentation.ts` now live under `src/`; the repository
  root holds config, `docs/`, `drizzle/`, `scripts/`, `supabase/` and `tests/`.
  Six config files changed one line each (tsconfig paths, `components.json` css,
  drizzle-kit schema dir, the `@` alias in both vitest configs, and the eslint
  glob block, which collapsed from six globs to `src/**`). `scripts/seed.ts` is
  the only source file touched — it reaches `lib/` relatively because `tsx` runs
  it outside the Next runtime. `docs/SPEC.md` path references updated to match.
- **`.claude/` harness added.** Seven scoped rule files (`structure`, `data`,
  `ai`, `outreach`, `ui`, `testing`, `git`), five role subagents (`pm`,
  `architect`, `engineer`, `qa`, `reviewer`), three commands (`/slice`,
  `/verify`, `/handoff`), and a committed permission allowlist.
- **`CLAUDE.md` slimmed** from 7755 to 4647 bytes and turned into a router: the
  ten rules stay always-loaded as one-liners, the detail behind each lives in the
  rule file for its area and is read only when that area is touched.
- **Role trailers on commits.** Every commit now carries `Role:` and, where a
  role verified it, `Reviewed-by:`. Read back with
  `git log --grep='^Role: engineer'`.

---

## Slice 3a — webhook + dedupe (done 2026-08-26)

SPEC §2 in full: signed ingestion, idempotency, four-strategy dedupe. No new
runtime dependency was added.

### What shipped

| File | Role |
|---|---|
| `src/lib/leads/normalize.ts` | canonical domain / email / phone / company name. Pure, total, never throws. |
| `src/lib/leads/dedupe.ts` | the four strategies in SPEC order, over an injected lookup so the ordering is testable without a database. |
| `src/lib/leads/ingest.ts` | transactional batch, merge-on-duplicate, audit rows. |
| `src/app/api/webhooks/n8n/leads/route.ts` | raw-body HMAC → Zod → idempotency claim → ingest. |
| `drizzle/0004_freezing_bloodscream.sql` | `companies.name_normalized`. |
| `drizzle/0005_pg_trgm.sql` | pg_trgm, a search_path-pinned similarity wrapper, trigram index. |
| `tests/unit/dedupe.test.ts` | 82 cases — 39 of them phone forms. |
| `tests/integration/ingest.test.ts` | 24 cases through the real route handler. |
| `docs/n8n-integration.md` | the n8n side of the contract, with the Code node to paste. |

### The acceptance criterion, proved twice

SPEC §10: *"Given the same n8n payload posted twice, the second inserts 0 rows and
returns `duplicates` equal to the item count."* Covered by
`tests/integration/ingest.test.ts`, and separately over real HTTP against
`pnpm dev` with a five-item payload:

```
forged signature  → 401 {"error":"invalid_signature"}
first delivery    → {"accepted":5,"inserted":3,"duplicates":1,
                     "rejected":[{"index":3,"reason":"no_contact_channel"}],"replayed":false}
same payload again→ {"accepted":5,"inserted":0,"duplicates":4,
                     "rejected":[{"index":3,"reason":"no_contact_channel"}],"replayed":true}
```

The single duplicate in the first delivery is the same shop written twice in one
payload — `https://WWW.PetShopBahagia.co.id/kontak?utm_source=maps` and
`http://petshopbahagia.co.id`, phones `0812-3456-7890` and `+62 812 3456 7890`.
It resolved against a row the same transaction had just written.

### Things the n8n workflow taught us that SPEC did not

The owner supplied the real lead-hunter export before the schema was written,
which changed three decisions:

1. **Field names did not match at all.** The workflow emits Google Sheets column
   headers (`Nama Bisnis`, `No. Telepon`); SPEC specifies `company_name`, `phone`.
   Written from SPEC alone, every item would have been rejected on the first run.
   Resolved on the n8n side — see decision 21.
2. **Landlines must normalise.** SPEC §2 lists only mobile forms (`08xx`, `62xx`,
   `+62xx`), but Google Maps returns office numbers constantly and the workflow
   passes them through. `normalizePhone` therefore accepts the whole national
   plan, not just `8xx`. `(031) 876-5432` → `+62318765432`.
3. **A scraper sentinel can merge every company at once.** The workflow routes
   website-less businesses to `https://no-website.invalid`. Had that ever reached
   `normalizeDomain`, every website-less company in a batch would have collapsed
   into one row on the domain strategy. RFC 2606 / 6761 reserved names are now
   rejected outright, with a test pinning it.

### Measured, not assumed

SPEC's 0.85 trigram threshold is strict. Against this database:

| Pair | Similarity | Merges? |
|---|---|---|
| `bahagia petcare` vs `petcare bahagia` | 1.00 | yes — trigrams ignore word order |
| `pet shop surabaya` vs `pet shops surabaya` | 0.84 | **no** |
| `…sejahtera` vs `…sejahtra` (one-letter typo) | 0.82 | **no** |
| `bahagia petcare` vs `bahagia petcare surabaya` | 0.64 | no |

So typos are not caught. That is the safe direction — merging two companies that
are genuinely different is not something the product can undo — but it is a
product call the owner may want to revisit once there is real import volume.

### Open questions left for the owner

1. **A duplicate company in a *different* campaign creates no lead.** SPEC says
   "on duplicate: don't insert". Taken literally, a company found for campaign A
   and later targeted by campaign B gets no lead for B. That may be wrong, but
   guessing was worse than asking.
2. **One webhook secret for all workspaces.** `N8N_WEBHOOK_SECRET` is global. Fine
   at one workspace; before the second, the secret belongs per-workspace in
   `integrations`.
3. **No per-IP rate limit on the webhook.** The signature is the gate, and item
   count is capped at 1000. A real limiter needs a store and should arrive with
   the first public route that has no signature.

---

## Prompt 3 — ingestion + dedupe: readiness assessment (2026-08-26)

Asked: can we start "Prompt 3 — Ingestion + dedupe" (SPEC §2 and §3)?

**Verdict: yes for the first slice, no for the prompt as one unit.** Nothing in
the prompt is blocked by an unmade design decision, but the prompt bundles five
deliverables across two SPEC modules, and two of them cannot be *verified* on
this machine today. CLAUDE.md §4 allows one vertical slice at a time.

### Already in place — no work needed

- `companies`, `contacts`, `leads`, `campaigns`, `activities` and
  `webhook_events` all exist, migrated and RLS-policied.
- `webhook_events` carries a unique index on `(provider, idempotency_key)`, so the
  replay test the prompt asks for ("post the same payload twice → second insert
  is 0 rows") is enforceable in the database, not only in application code.
- `companies.dedupe_key` exists, plus a **partial** unique index on
  `(workspace_id, domain) where domain is not null`, so companies found by phone
  alone do not collide on a null domain.
- `contacts.phone` is already specified and seeded as E.164 with the scraped
  `08xx` form kept in `raw` — the normalisation target dedupe must produce is
  fixed, and already demonstrated by 60 seeded rows.
- `N8N_WEBHOOK_SECRET` is hard-required (min 32 chars) and validated at boot, so
  HMAC verification has its secret.
- `Result<T, E>` and the typed-error convention exist (rule 9).

### Not in place

| Needed by | Missing |
|---|---|
| all of it | `src/lib/leads/` does not exist — no `dedupe.ts`, no ingestion module |
| webhook | `src/app/api/webhooks/` does not exist; `/api/health` is the only route built |
| dedupe strategy 4 | `pg_trgm` is not enabled in any migration; fuzzy name+city at trigram ≥ 0.85 needs it |
| CSV upload | the product has **zero** mutations today — no server action, no form, no file upload anywhere (known issue 4). This slice writes the first one. |
| enrichment | `pg-boss` is not installed; no worker, no `/api/cron/tick`, no job schema |
| enrichment | `src/lib/ai/agent.ts` and `models.ts` do not exist. Rule 2 puts every LLM call behind `agent.ts`, so the "LLM company summary with confidence" step cannot be written until that groundwork lands. |
| enrichment | `GOOGLE_GENERATIVE_AI_API_KEY` is unset (optional in `env.ts`) — the LLM step has no key to call with. |

### Proposed split — three slices, in this order

**3a. Webhook + dedupe** (SPEC §2, prompt items 1 and 2). Self-contained: no new
runtime dependency, no LLM, no UI. `POST /api/webhooks/n8n/leads` with raw-body
HMAC, Zod validation, `webhook_events` idempotency, a transactional batch insert,
and `src/lib/leads/dedupe.ts` with the four strategies in SPEC order. Unit tests
for Indonesian phone normalisation — `08xx` / `8xx` / `62xx` / `+62xx` / spaces /
dashes / `(0)` / doubled country code / too short / non-numeric — at least the 25
cases the prompt asks for, the hostile ones being the point. **This slice can
start today.**

**3b. CSV upload** (prompt item 3, XLSX dropped — decision 18). Depends on 3a's
pipeline existing, and introduces both the product's first mutation path and a
file-parser dependency.

**3c. Enrichment worker** (SPEC §3, prompt items 4 and 5). pg-boss,
`/api/cron/tick`, the `enrich_company` job, fetch + robots.txt + HTML-to-text
extraction, and the LLM summary. **3a and the `agent.ts` groundwork come first** —
rule 2 makes `agent.ts` a prerequisite, not an optional refactor.

### Owner decisions — taken 2026-08-26

| Dependency | For | Decision |
|---|---|---|
| `pg-boss` | 3c | **Approved.** It creates its own schema in the same Postgres. |
| CSV parser | 3b | **Approved — CSV only. XLSX is dropped from the MVP.** See decision 18. |
| an HTML-to-text step | 3c | **Approved.** SPEC §3 requires stripping HTML before the regex. |
| `ai` + `@ai-sdk/google` + `@ai-sdk/openai` | 3c | **Approved.** Installed alongside `agent.ts`. |

None of these is installed yet. Each goes in with the slice that uses it, so a
dependency never sits in `package.json` ahead of the code that needs it and the
gate always covers what is actually there.

Fuzzy matching needs **no** dependency: `pg_trgm` ships with Postgres and is
turned on in a migration.

### Where n8n stops

Confirmed against SPEC §2: **n8n scrapes, and nothing else.** It finds businesses
and POSTs them to one signed webhook. Dedupe, enrichment, scoring, drafting,
approval, sending, reply classification, status transitions and the dashboard all
run in this platform. n8n has no database access and no second integration point —
it appears in SPEC exactly three times, all of them about that one webhook.

### The prompt's own acceptance test is now provable — resolved 2026-08-26

"Post the same payload twice → second insert is 0 rows" needed real Postgres.
It has one now. `pnpm test:integration` runs and passes 22 tests, so the replay
proof for slice 3a will be **written and actually executed**, not written and
deferred. This was the single largest risk to Phase 2 and it is gone.

One note for slice 3b: `storage` and `realtime` are deliberately `enabled = false`
in `supabase/config.toml` to keep the local stack light. CSV upload should parse
the file in memory and never persist it, which keeps that decision intact. If we
ever need to keep the original file, flipping `storage` back on is a config change
plus a local restart, not a redesign.

---

## Next up

Recommended order. One vertical slice at a time (schema → server logic → API →
UI → test), nothing started until the previous slice is green.

1. ~~**Unblock the machine**~~ — **done 2026-08-26.** Stack runs, every gate green.
2. ~~**Slice 3a — webhook + dedupe**~~ — **done 2026-08-26.** `POST /api/webhooks/n8n/leads`, HMAC over the
   raw body, `webhook_events` idempotency, `src/lib/leads/dedupe.ts` (domain →
   phone → email → fuzzy name+city). Tables already exist.
3. **Workspace provisioning** — create a workspace on first sign-in, or an invite
   flow. A brand-new user still lands on "Anda belum punya workspace" and can only
   be rescued by `pnpm db:seed`. Not a blocker for 3a, which resolves its
   workspace from `campaign_id`.
4. **Slice 3b — CSV upload** into the same pipeline. ← *next.* Parser approved; XLSX dropped.
5. **`src/lib/ai/agent.ts` + `models.ts`** — the single LLM entry point and its
   `ai_runs` row. Prerequisite for both enrichment and qualification.
6. **Slice 3c — enrichment worker.** pg-boss, `/api/cron/tick`, `enrich_company`,
   plus documentation for running the worker locally.
7. **Module 3 — qualification.** `src/lib/scoring/rubric.ts`; the model returns
   per-factor sub-scores only and code computes the weighted total. The seed
   already writes rows in that shape.
8. **Module 5 + approvals** — content generation with `needs_input` gating.
9. **`src/lib/outreach/send-guard.ts`** — before any provider adapter exists, so
   there is never a code path that sends without it.

## Blocked

| Item | Needs |
|---|---|
| `pnpm test:e2e` | `pnpm exec playwright install chromium` (~150 MB download). Deliberately not run — it is the only gate still deferred. |

**Closed on 2026-08-26:**

- ~~`.env.local` missing~~ — written, complete, all six required variables present.
  Both Supabase keys came from `supabase status`; they are local demo keys valid
  only against 127.0.0.1, identical on any machine running this stack.
- ~~Docker not installed~~ — Docker Desktop 29.7.2, per-user install under
  `%LOCALAPPDATA%\Programs\DockerDesktop`. The failure mode worth remembering:
  `wsl --install` enables Virtual Machine Platform but the feature is inert until
  a reboot, and the installer's PATH change does not reach shells that were already
  open. Both symptoms look like a broken install and are neither.
- ~~Integration suite never run~~ — 22 tests passing.

`supabase_vector` sits in a restart loop locally. It is the log shipper for the
analytics container, nothing in the app or the tests depends on it, and the other
nine containers are healthy. Noted so nobody spends an afternoon on it.

**To run the stack from scratch:**

```
pnpm db:start            # Supabase CLI (Docker)
pnpm db:reset            # recreate, apply 0000-0003, seed
pnpm dev                 # sign in at /login, mail lands in Inbucket
```

---

## Known issues

1. **Drizzle bypasses RLS.** `src/lib/db/drizzle.ts` connects with `DATABASE_URL`, a
   privileged role. RLS protects the Supabase-client path only. Every Drizzle
   query must filter by `workspace_id` in application code — a missing filter is
   a security bug, not a style nit. Flagged in the file header comment, and
   pinned by an integration test that documents the bypass. Revisit if we later
   want `SET LOCAL role` per request.
2. **No workspace creation path.** Covered as next-up item 1.
3. **`listUsers({ perPage: 1000 })` does not paginate.** Two callers now:
   `scripts/seed.ts` and `listMembersWithEmail()` in `src/lib/auth/members.ts`. Fine
   for a dev seed and a handful of members; fix with the invite flow.
4. **Every screen is read-only.** No forms, server actions, or mutations exist
   anywhere in the product yet — including approve/reject on Persetujuan. The
   webhook writes, but nothing in the UI does.
5. **Imported leads are invisible until a screen shows them.** Ingestion writes
   companies, contacts and leads that the existing Leads screen renders, but there
   is no import history view and no way to see a rejection after the fact — the
   `rejected[]` array only exists in the HTTP response. `webhook_events` stores the
   payload, so nothing is lost; it is just not surfaced.
6. **`normalizePhone` peels a repeated `62` prefix.** Right for a doubled country
   code, which occurs in scraped data; wrong for a hypothetical landline whose
   area code is literally `62`, which is not in Indonesia's numbering plan.
   Documented in the function.

---

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Authed URLs are `/app/{workspace}/…` with a literal `/app` segment | Middleware matcher is exactly `['/app/:path*']`, and a workspace slug can never shadow a marketing route. CLAUDE.md §4 updated to match; it previously implied `/{workspace}/…`. |
| 2 | Integration env vars are `.optional()` for now | Gmail/WhatsApp/LLM credentials do not exist yet; requiring them would mean nothing boots. Each is promoted to required in the phase that ships its module. Core vars (Supabase, `DATABASE_URL`, `N8N_WEBHOOK_SECRET`) are hard-required today. |
| 3 | Pinned **Next.js 15**, not 16 | `create-next-app` now emits Next 16.3.1, but CLAUDE.md §1 specifies Next 15 and says not to change the stack without asking. Pinned to 15.5.23. **Open question for the owner** — 16 is stable and this is the cheapest moment to move. |
| 4 | Server env exposed as `serverEnv()`, not a bare `env` const | `lib/env.ts` is imported by client components for `publicEnv`. A top-level server parse would throw in the browser. A function call keeps everything in one file (rule 1) with no `Proxy` and no type assertion. |
| 5 | RLS lives in hand-written migrations (`0001`, `0003`) | drizzle-kit does not emit RLS policies, and the FKs to `auth.users` must not tempt drizzle-kit into managing the Supabase `auth` schema. |
| 6 | `next-themes` removed | Pulled in transitively by the shadcn `sonner`. Rewrote `components/ui/sonner.tsx` to drop it rather than accept an unapproved dependency for a dark-mode toggle we have not built. |
| 7 | `typedRoutes` left off | It cannot type the dynamically built `/app/${slug}/${segment}` hrefs without a cast, and casts are banned by rule 9. |
| 8 | Local Postgres via the Supabase CLI, not a hosted project | Migrations, RLS and the seed can be verified — and reset — offline, and the integration suite runs on any machine with Docker. A hosted project is still the target for staging. |
| 9 | Schema split into `lib/db/schema/` by domain | One file was already 15 tables away from unreadable. `drizzle.config.ts` accepts a directory, so nothing else changed. CLAUDE.md §4 lists `schema.ts`; the directory supersedes it. |
| 10 | The seed is deterministic and idempotent | UUIDv5 over a fixed namespace plus a seeded RNG means re-running it never duplicates rows and every test can assert exact counts. It also keeps screenshots stable across machines. |
| 11 | Env files comment out unset optional vars instead of writing `""` | `.optional()` in Zod means "may be `undefined`", not "may be blank". dotenv turns `FOO=""` into `''`, which then fails `.min(1)` (or `z.url()`) and kills the boot that rule 1 deliberately makes fatal. Verified against the real `.env.local`: optional keys now parse to `undefined`. |
| 12 | Application code lives in `src/` | The root held 16 config files interleaved with source. `src/` is a first-class Next.js convention, and every internal import already went through the `@/` alias, so the move cost six one-line config edits and one source file. CLAUDE.md §4 is superseded by `.claude/rules/structure.md`. |
| 13 | The harness lives in `.claude/`, not a root `rules/` directory | `.claude/agents/` and `.claude/commands/` are read automatically by Claude Code; a root `rules/` directory would need a manual reference every time. The rule files are ordinary markdown either way. |
| 14 | The stack table and definition of done stayed in `CLAUDE.md` | They are consulted on nearly every slice, so moving them into an on-demand file would trade a small constant saving for an extra read most turns. The directory tree and the old §6 compliance section moved out, since they are area-specific. |
| 15 | Role attribution is a commit trailer, not a subject prefix | `Role: engineer` in the footer keeps the subject line conventional-commit clean while staying greppable via `git log --grep`. |
| 16 | "Prompt 3" ships as three slices (3a webhook + dedupe, 3b upload, 3c enrichment), not one | It bundles SPEC §2 and §3: five deliverables, the product's first mutation and its first background worker. CLAUDE.md §4 is one vertical slice at a time. 3a is the only part with no new dependency and no external service, so it goes first and the gate stays meaningful. |
| 17 | Fuzzy dedupe uses `pg_trgm` in Postgres, not a JS similarity library | SPEC §2 specifies trigram ≥ 0.85, which is `similarity()` verbatim. The extension ships with Postgres, needs no approval, and keeps the comparison in the same query as the workspace filter instead of pulling candidate rows into Node. |
| 18 | CSV only for bulk upload; XLSX is out of the MVP | Owner decision, 2026-08-26. An XLSX reader is a large dependency with a poor CVE history, for a format a salesperson can export as CSV in two clicks. Revisit only if a real user is blocked by it. |
| 19 | `pg-boss`, an HTML-to-text library and the Vercel AI SDK are approved | Owner decision, 2026-08-26. All three were already implied by the CLAUDE.md §1 stack table; this makes it explicit. Each is installed by the slice that uses it, not up front. |
| 20 | `.env.local` ships the two unknown Supabase keys commented out, not as placeholder strings | Both are validated as `z.string().min(1)`, so a placeholder would pass the boot check and then fail at the first auth call with an opaque "Invalid API key". Commented out, rule 1 fires at boot and names the exact variable. Consistent with decision 11. |
| 21 | The n8n workflow maps to the API contract, not the other way round | Its keys (`Nama Bisnis`, `No. Telepon`) are Google Sheets column headers — a presentation format. Baking them into the webhook would force CSV upload and every future source to speak them too. One canonical shape, many sources; `docs/n8n-integration.md` carries the Code node so the change costs one paste. |
| 22 | Merge on duplicate fills blanks only, never overwrites | The stored value may be a correction a human made by hand. A scraper re-running tomorrow must not silently undo it. |
| 23 | `companies.name_normalized` is a stored column, not a SQL expression | Fuzzy matching must compare the same shape the application produces. Recomputing the legal-form stripping in SQL would be a second definition of "the same name", and the two would drift. Stored, it also gives the trigram index something to index. |
| 24 | Dedupe lookups are injected, not imported | It makes the strategy ordering — the part with real consequences if it changes — unit-testable with no database, which is what `.claude/rules/testing.md` demands of this file. |
| 25 | The integration suite aliases `server-only` to a stub | The guard is a build-time boundary that stops client bundles pulling in server code; this suite produces no bundle. Aliasing it lets the acceptance test drive the real route handler instead of a copy of its logic. |

### Dependencies added beyond the CLAUDE.md §1 stack table

Approved with the Phase 0 plan: `server-only` (makes rule 6 a build error),
`typescript-eslint` (makes rule 9 a lint error), `sonner` (toast), `tsx` (runs
`scripts/seed.ts`), `dotenv` (env for drizzle-kit and scripts), `tw-animate-css`
(required by the shadcn components we generated).

Added in Phase 1: `supabase` (the CLI, dev dependency — runs the local Postgres
the integration suite tests against).

`pnpm` itself was installed globally via npm — `corepack enable` failed with
EPERM against `C:\Program Files\nodejs`.
