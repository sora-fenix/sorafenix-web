# SORA — Progress

Current state and next steps. Updated after every task, per CLAUDE.md §4.

**Last updated:** 2026-09-04 (eighth pass: the LLM entry point)
**Phase:** 2 in progress. Module 1 (ingestion) is done and feeding real leads.
`src/lib/ai/agent.ts` now exists, so the modules that need a model are unblocked.
Slice 3b (CSV upload) is deferred — see decision 33. Module 3 (qualification) is
next.

---

## Where we are

The database is real. Every domain table from `docs/SPEC.md` exists, is
protected by RLS, and is filled by a deterministic seed, so the product can be
demoed end to end without a single external service. All nine module screens read
live data — the Phase 0 placeholders are gone.

Ingestion is real too: leads arrive from n8n through a signed webhook, are
deduplicated, and land in `data-riil`. The LLM entry point now exists behind them.
What still does not exist is everything in between — nothing scores a lead,
enriches a company, drafts a message or sends one. Inside a workspace every screen
remains read-only; creating a workspace is still the only mutation the UI can make
(known issue 4).

| Gate | Status |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ clean, 0 errors 0 warnings |
| `pnpm test` | ✅ 165 tests, 6 files |
| `pnpm build` | ✅ all 18 routes built |
| `pnpm test:integration` | ✅ 64 tests, 5 files |
| `pnpm ai:smoke` | ✅ real call to `gemini-3.7-flash`, Zod-validated, `ai_runs` row written |
| `pnpm test:e2e` | ⏸️ written, not run — Playwright browsers still not installed |

All seven gates were run on 2026-09-04 against the live local stack. Six are
green; the seventh is a deliberate deferral, not a failure.

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

## Workspace provisioning (done 2026-08-28)

Closes known issue 2. A user who signs in with no membership can now create a
workspace instead of reading an instruction to run `pnpm db:seed`.

More importantly, this is the **product's first mutation**. The shape it
establishes — client form → `'use server'` action → `lib/` module returning a
`Result` → one Drizzle transaction — is what CSV upload (3b) and approvals
(Module 5) will copy, so the pattern mattered more than the feature.

### What shipped

| File | Role |
|---|---|
| `src/lib/workspace/slug.ts` | name → URL slug. Pure, total, reserved-word aware. |
| `src/lib/workspace/provision.ts` | workspace + owner membership in one transaction. |
| `src/app/app/actions.ts` | `'use server'`, Zod at the boundary, Indonesian error copy. |
| `src/app/app/create-workspace-form.tsx` | `useActionState`, mirrors `login-form.tsx`. |
| `src/app/app/page.tsx` | the dead-end empty state became the form. |
| `tests/unit/workspace-slug.test.ts` | 30 cases. |
| `tests/integration/provision.test.ts` | 6 cases against real Postgres. |

No schema change and no migration: `workspaces`, `memberships` and
`workspaces_slug_key` already existed.

### Why this write has to be server-side

Not a shortcut — a constraint the schema already encodes. `drizzle/0001_rls.sql`
gives `workspaces` no INSERT policy at all, and `memberships_insert_admin`
requires the caller to already hold owner or manager **in the workspace being
written to**. The creator's own first membership row is therefore unreachable
through the RLS path by construction. The migration comment predicted this;
implementation confirmed it.

### The rollback case is the one worth having

A workspace whose owner membership failed to write can never be reached by
anyone again — no membership means no `listWorkspacesForUser` row, and the
`/app` index would just offer to create another one. Both inserts share a
transaction, and `provision.test.ts` proves it by provisioning for a user id that
satisfies the uuid type but not the FK to `auth.users`: the membership insert
fails and **no workspace row survives**.

### Slug collisions are decided by the index, not by a select

`provisionWorkspace` inserts with `onConflictDoNothing` and steps to the next
suffix, rather than checking availability first. Between a check and a write a
concurrent signup can take the slug; `workspaces_slug_key` is the only thing that
actually decides, so it decides. Three workspaces named the same thing get
`…-workspace`, `…-workspace-2`, `…-workspace-3`.

### Deliberately not in scope

No "create a second workspace" entry in the switcher, and no campaign creation.
Owner decision — see decision 30 for why the campaign half matters.

---

## n8n wiring (2026-08-28)

Slice 3a built and proved the SORA side. This session connected the outside world
to it. No application code changed — the work was a tunnel, a documentation fix,
and an end-to-end proof over the public internet.

### What was actually proved

`cloudflared` quick tunnel in front of `pnpm dev`, then a signed three-item payload
posted **from outside the machine** at `https://…trycloudflare.com`:

```
first delivery  → {"accepted":3,"inserted":2,"duplicates":1,"rejected":[],"replayed":false}
same key again  → {"accepted":3,"inserted":0,"duplicates":3,"rejected":[],"replayed":true}
```

The rows that landed confirm normalisation end to end, not just in unit tests:

| Sent | Stored |
|---|---|
| `https://WWW.CakrawalaPet.co.id/kontak?utm_source=maps` | domain `cakrawalapet.co.id` |
| `Halo@CakrawalaPet.co.id` | `halo@cakrawalapet.co.id` |
| `0812-3456-1122` and `+62 812 3456 1122` | one company, `+6281234561122` |
| `(031) 876-5432` behind `https://no-website.invalid` | company kept, phone `+62318765432`, no domain |

The sentinel behaved as designed: it produced no domain, so the landline was the
only thing holding that company's identity, and it was enough.

### The documentation was wrong for n8n Cloud

`docs/n8n-integration.md` told the reader to put the secret in `$env`. On n8n Cloud
that fails with `access to env vars denied` — `N8N_BLOCK_ENV_ACCESS_IN_NODE`
defaults to `true` and is a self-hosted setting with no Cloud equivalent. Anyone
following the document on Cloud would have hit it on the first run. Replaced with a
`SORA Config` Set node, which works on every deployment. See decision 26.

`require('crypto')` was checked at the same time and is **fine** — crypto is
whitelisted in the Code node on n8n Cloud, so that half of the document stood.

### Still to be done by hand, in the n8n UI

~~The three nodes are specified and the payload contract is proved, but the
workflow itself has not been edited.~~ **Done 2026-09-01** — see below. The
edits now live in `n8n/workflows/sora-lead-hunter.json`.

---

## n8n rebuilt locally, in Docker (2026-09-01)

The laptop running n8n died. Nothing in the app was lost — but the workflow was,
because it existed only inside that machine's Docker volume. That is the finding
worth keeping: **an integration that lives in one person's container is not
integrated with anything.** The workflow is now a repo artefact.

### What was built

| File | Why |
|---|---|
| `docker-compose.n8n.yml` | n8n 2.36.9, own volume, own SQLite. Started with `--env-file .env.local` so the signing secret cannot drift from the verifying one. |
| `n8n/workflows/sora-lead-hunter.json` | The workflow, patched and committed. No secrets in it. |
| `scripts/create-campaign.ts` | `pnpm campaign:create` — the webhook resolves a workspace from `campaign_id`, so ingestion is impossible until a campaign exists. |
| `scripts/create-workspace.ts` | `pnpm workspace:create` — a workspace the seed does not own, for leads worth keeping. Repeats `provision.ts`'s two inserts because that module is `server-only`. |
| `package.json` | `n8n:start`, `n8n:stop`, `n8n:logs`, `workspace:create`, `campaign:create`. |

The workflow changes are the three that were outstanding: `maps_cid` now survives
`Extract Contacts`, `Append to Sheet` is gone, and `SORA Config →
Build SORA Payload → Send to SORA` is the new tail.

### The task runner filters the environment — verified, not assumed

Self-hosted n8n can set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which suggests a
Code node could read the secret from `$env` directly and skip the Set node. It
cannot. Code nodes run in a separate task runner process, and n8n hands it a
filtered environment:

```
main process (pid 7)   SORA_WEBHOOK_SECRET, SORA_CAMPAIGN_ID, SORA_WEBHOOK_URL, N8N_BLOCK_ENV_ACCESS_IN_NODE
task runner (pid 19)   NODE_FUNCTION_ALLOW_BUILTIN=crypto, N8N_RUNNERS_* — nothing else
```

Read out of `/proc/<pid>/environ` in the running container. So `SORA Config`
stays a Set node — its expressions evaluate in the main process, which can see
the variables — and decision 26 survives for a second, better reason than the one
it was written for. A Code node reading `$env` would have signed with `undefined`
and produced a 401 that reads exactly like a wrong secret.

`NODE_FUNCTION_ALLOW_BUILTIN=crypto` *does* reach the runner, so
`require('crypto')` in `Build SORA Payload` works.

### Proved end to end, before touching the UI

From inside the container, against `pnpm dev` on the host over
`host.docker.internal` — no tunnel:

```
correct signature  → 200 {"accepted":1,"inserted":0,"duplicates":0,
                          "rejected":[{"index":0,"reason":"no_contact_channel"}],"replayed":false}
sha256=000…000     → 401 {"error":"invalid_signature"}
```

The probe item deliberately carries no contact channel, so the whole chain —
container → host → HMAC → campaign lookup → ingest — is exercised without
writing a fake company into real data.

Gate after the change: `typecheck` clean, `lint` clean, `test` 129/129.

### The first real leads, and getting them out of the seed's way

The owner ran the workflow: **10 Surabaya pet shops** landed through the real
path — Serper → n8n → HMAC → dedupe → `leads`. Phones normalised exactly as the
unit tests promised, landlines included (`+62315995509`).

They landed in `maju-bersama`, which `scripts/seed.ts` deletes on every run. So
a second workspace was created and the import moved into it:

```
pnpm workspace:create "Data Riil" --members-from maju-bersama
```

then the campaign row itself was re-pointed at the new workspace — not copied —
so `SORA_CAMPAIGN_ID` never changed and n8n needed no reconfiguration. Companies,
contacts, leads and activities moved with it, in one transaction that asserted no
row was left straddling two tenants before committing.

**A mistake worth recording:** the same move updated `webhook_events` with
`where provider = 'n8n'`, which is broader than it looks — the seed writes two
demo rows with that provider. They travelled to `data-riil`, survived the
cascade that a re-seed relies on, and collided on `(provider, idempotency_key)`
the next time the seed ran, leaving `maju-bersama` half-built. Deleting the two
strays and re-running `pnpm db:seed` restored it. The lesson is that "rows from
n8n" and "rows the seed invented about n8n" are not the same set, and only the
lead-bearing tables could be identified by a join.

Proved afterwards, which is the whole point of the exercise:

```
pnpm db:seed             → maju-bersama rebuilt: 60 / 60 / 150
pnpm test:integration    → 52 passed (4 files)
data-riil                → 10 leads, 10 companies, 10 activities, untouched
```

### Batch scraping (2026-09-01, same session)

The workflow searched one keyword in one city per Execute. It now sweeps
**keyword × city × page**: a `Search Plan` Code node emits the combinations and
`Loop Over Searches` (splitInBatches, size 1) drives the existing chain once per
combination, looping back from `Send to SORA`. `Run Summary` sits on the done
output and totals the responses.

Each iteration keeps its own `idempotency_key` — now carrying the page number —
so one failed search costs only itself, and `Normalize Place` still reads the
right city because `$('Set Search Params')` resolves to the current iteration.
`Every morning at 08:00` is present and disabled, one toggle plus Active away.

Two things this taught us about n8n 2.x, both caught by its import validator:

- **Duplicate node names are now rejected.** The original export had five sticky
  notes all called `Sticky b100`. They are named after their headings now.
- The workflow was patched by exporting the live copy, editing, and
  `n8n import:workflow` back onto the same id, which keeps the Serper credential
  bound. Re-importing the committed file instead would unbind it — the
  committed copy carries a placeholder credential id on purpose.

**Executed by the owner, same day, and it works.** The batch key format came
through as designed — `run_pet-shop-surabaya-p1_20260901064802` — and the second
sweep of the same city added one new business and merged nine, which is dedupe
doing exactly its job across runs.

Two findings from the first real numbers:

1. **`jumlah: 20` did not produce 20.** Both runs posted 10 items. Either Serper
   `/places` ignores `num` and pages at 10, or `Extract Contacts` dropped half on
   its no-contact-channel filter. Not yet distinguished — the answer is visible
   in the execution's item count between `Serper Places` and `Split Out Places`.
   Until it is settled, **`PAGES` is the reliable way to get more per city**, not
   a bigger `jumlah`.
2. **This segment has no websites.** All 11 companies came back with an empty
   domain, so `with_email` is 0 and `Fetch Website` / `Fetch Contact Page` did
   nothing but time out against the `no-website.invalid` sentinel. Every business
   has a phone (11/11) and 8 of 11 have WhatsApp, because the mobile numbers
   pass `is_mobile`. For pet shops in Surabaya the outreach channel is WhatsApp,
   not email — worth remembering when Module 6 and 7 are prioritised.

### Left for the owner, in the n8n UI

Two steps, once: create the local owner account at http://localhost:5678, then
import the workflow and attach a Header Auth credential (`X-API-KEY` = the Serper
key) to `Serper Places`. The key is encrypted into the volume by
`N8N_ENCRYPTION_KEY` and never enters the repo.

---

## `src/lib/ai/agent.ts` — the single LLM entry point (2026-09-04)

CLAUDE.md rule 2 has said "all LLM calls go through `src/lib/ai/agent.ts`" since
Phase 0, and the file did not exist. Everything left on the roadmap — enrichment,
qualification, content generation, reply classification — is behind it. This slice
is that file and nothing else.

### What shipped

| File | Role |
|---|---|
| `src/lib/ai/models.ts` | The only place a model id appears. Primary, fallback, paid-tier prices, `estimateCostUsd()`. No imports at all. |
| `src/lib/ai/policy.ts` | The retry and escalation decisions, pure and import-free. |
| `src/lib/ai/agent.ts` | `runAgent()` — Zod in and out, a deadline, retry with backoff, escalation to the fallback, an `ai_runs` row per attempt, returns a `Result`. |
| `scripts/ai-smoke.ts` | `pnpm ai:smoke` — one real call, printed with the row it wrote. |
| `tests/unit/ai-models.test.ts` | 13 cases: cost arithmetic and registry invariants. |
| `tests/unit/agent-policy.test.ts` | 23 cases: error classification, backoff, `Retry-After`, error text. |
| `tests/integration/agent.test.ts` | 12 cases against real Postgres with a scripted provider. |

Dependencies added: `ai@7.0.91`, `@ai-sdk/google@4.0.63`, `@ai-sdk/openai@4.0.57` —
all three pre-approved in decision 19. No schema change and no migration: `ai_runs`
already had exactly the columns rule 2 names.

### Three files, not one, and why

Rule 2 names one file, and the orchestration is in it. The two next to it exist for
a reason the rule does not cover: `agent.ts` imports `server-only` and the Drizzle
handle, and `drizzle.ts` calls `serverEnv()` at module load — so anything importing
`agent.ts` needs a `DATABASE_URL`, which `.claude/rules/testing.md` says the unit
suite must live without.

So the decisions with real consequences when a provider misbehaves — classify this
error, retry or escalate, wait how long — live in `policy.ts`, which imports
nothing and is unit-tested exhaustively. `models.ts` is the same shape for the same
reason. Neither calls a model; `agent.ts` is still the only thing that can.

### Errors are read by shape, not by class

`policy.ts` matches on `statusCode`, `isRetryable` and `responseHeaders` rather
than on `instanceof APICallError`. A wrapped, re-thrown or faked error is then
classified exactly like the real one, which is what makes the whole failure surface
testable without a provider. The escalation it produces:

| Condition | Verdict | Next |
|---|---|---|
| abort / our own deadline | `timeout` | retry |
| 429 | `rate_limited` | retry, honouring `Retry-After` over our own curve |
| 5xx | `provider_error` | retry |
| 400 / 401 / 403 / 404 | `provider_error` | **escalate immediately** — the same request gets the same answer |
| answer fails the Zod schema | `invalid_output` | one more chance on the same model, then escalate |
| no key on any model | `no_model_available` | return before any call, and write **no** `ai_runs` row |

`rate_limited` is a kind of its own precisely because the free tier hits it and it
is the one failure that answers to waiting.

### One `ai_runs` row per attempt

A call that fails over writes two rows: the failed primary and the successful
fallback. A single summary row would hide the failure that made the fallback
necessary, which is the thing worth seeing on a cost dashboard. Failed attempts
record `tokens_in`/`tokens_out` as null and cost as zero — the SDK throws before
reporting usage, and zero is honest where a guess is not.

**The audit write is best-effort, and that is a deliberate exception to rule 10.**
A Postgres hiccup must not discard a generation the provider was already paid for.
The failure is logged loudly; the answer still returns.

### The tests fake the provider and nothing else

`tests/integration/agent.test.ts` takes `productionDeps()` and replaces only the
provider, the clock and the sleep — so the `ai_runs` rows it asserts are written by
the same code production runs. Retry, escalation, both retry budgets, the timeout
and the no-key path are each driven deterministically, which no real model would
do on request.

What a fake cannot prove is that the model id exists, the provider package is wired
right, and the SDK's usage fields are read under the right names. That is `pnpm
ai:smoke`, and it **has not run** — see below.

### Cost is recorded at the paid rate even though the key is free

`gemini-3.7-flash` has a Google AI Studio free tier and that is the key in use.
`estimateCostUsd()` nevertheless records the published paid rates ($0.75 / $3.75
per 1M, verified 2026-09-04; `gpt-4.1-mini` is $0.40 / $1.60). `ai_runs.cost_usd`
exists to answer "what does this cost at volume", and a column of zeros answers
nothing and would become quietly wrong the day the project moves to a paid key.

Google's flash rate **doubles on 2027-01-01** — $1.50 / $7.50. Not modelled as a
date-dependent rate; it is one line in `models.ts` to edit, and an estimate that
changes shape at midnight is harder to reason about than one that does not.

### The smoke test earned its keep on the first run: the primary model was dead

`gemini-2.5-flash` — pinned in CLAUDE.md §1 since Phase 0 — is **no longer
available to new API keys.** The first real call said so:

```
FAILED  provider_error
  AI_APICallError: This model models/gemini-2.5-flash is no longer available to
  new users. Please update your code to use models/gemini-3.6-flash …
```

Nothing in the repository had changed. A model id can die on the provider's
schedule, and only a real call finds out. Two things were validated by the failure
itself: the 404 was classified non-retryable, so it made exactly **one** attempt
and no backoff, and it stopped instead of escalating because no `OPENAI_API_KEY`
is set — both correct.

### Choosing the replacement, by probe rather than by documentation

`ListModels` still lists `gemini-2.5-flash`, so the listing is not authoritative
about what a key can actually call. Every candidate was probed directly:

| Model | `generateContent` | Free tier | Paid rate, to 2026-12-31 |
|---|---|---|---|
| `gemini-2.5-flash` | **404** — closed to new keys | — | — |
| `gemini-3.5-flash` | 200 | yes | $1.50 / $9.00 |
| `gemini-3.6-flash` | 200 | yes | $0.75 / $3.75 |
| `gemini-3.7-flash` | 200 | yes | $0.75 / $3.75 |
| `gemini-3.8-flash` | 200 | yes | $0.75 / $3.75 |

The owner first picked `gemini-3.8-flash` — newest in the cheapest band. **That
choice was reversed on evidence.** Under load it served 6 of 8 calls, the other two
returning 503 UNAVAILABLE; `gemini-3.7-flash` served 8 of 8 at the identical price.
A newest model that fails a quarter of its calls costs every lead two backoffs, and
with no OpenAI key there is no fallback to catch them. Primary is
**`gemini-3.7-flash`**.

The retry policy was validated a second time here too: the 503s were classified
retryable, and the smoke run made three attempts before giving up.

### Proved end to end

```
OK
  model      gemini-3.7-flash
  answer     {"sentiment":"positif","confidence":0.99}
  tokens     in 40 / out 131
  cost       $0.000521 (paid-tier rate; free tier bills nothing)
  latency    24579ms
  attempts   1

ai_runs row written:
{ agent: 'classify_reply', model: 'gemini-3.7-flash', tokens_in: 40,
  tokens_out: 131, cost_usd: '0.000521', latency_ms: 24579, ok: true }
```

Non-null token counts are the point of that output: they are what proves the SDK's
usage fields are being read under the right names. A moved field would have looked
like a successful call costing exactly nothing, and the script fails loudly on
that rather than printing a zero.

### The default timeout was wrong, and measurement said so

Three consecutive smoke calls returned in **24.6s, 5.3s and 22.2s** — for a
two-field answer. The model spends output tokens thinking (131, 289 and 232 of
them for that same answer), and how long that takes varies wildly.
`DEFAULT_TIMEOUT_MS` shipped at 30s, which would have turned an ordinary call into
a `timeout` whenever the model felt thorough. It is 60s now.

The other lever is `providerOptions.google.thinkingConfig.thinkingBudget`, which
would cut both the latency and the cost. Deliberately not pulled here: how much
reasoning a lead score deserves is Module 3's decision, not the transport's. It is
the first thing to try if scoring 14 leads turns out to take five minutes.

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
3. ~~**Workspace provisioning**~~ — **done 2026-08-28.** First-workspace path only;
   no invite flow and no second-workspace entry in the switcher yet.
4. ~~**`src/lib/ai/agent.ts` + `models.ts`**~~ — **done 2026-09-04.** The single LLM
   entry point, its `ai_runs` row per attempt, and `pnpm ai:smoke`. Brought forward
   ahead of 3b; see decision 33.
5. ~~**Put a key in `.env.local` and run `pnpm ai:smoke`**~~ — **done 2026-09-04.**
   Free-tier Google key, real call, `ai_runs` row written. It cost the primary
   model its life; see above.
6. **Module 3 — qualification.** ← *next.* `src/lib/scoring/rubric.ts`; the model returns
   per-factor sub-scores only and code computes the weighted total. The seed
   already writes rows in that shape, and `data-riil` has real leads with no score.
   This is where `src/lib/ai/prompts/` and `src/lib/ai/schemas/` get their first
   files.
7. **Slice 3c — enrichment worker.** pg-boss, `/api/cron/tick`, `enrich_company`.
   Worth reshaping first: SPEC §3 fetches websites, and every company scraped so
   far has none. The enrichment data for this segment is already in
   `companies.raw` — rating, review count, category, `maps_cid` from Serper.
8. **Slice 3b — CSV upload.** Deferred, not dropped. Parser approved; XLSX dropped.
9. **Module 5 + approvals** — content generation with `needs_input` gating.
10. **`src/lib/outreach/send-guard.ts`** — before any provider adapter exists, so
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
pnpm workspace:create "Data Riil" --members-from maju-bersama
pnpm campaign:create --workspace data-riil   # prints SORA_CAMPAIGN_ID
pnpm n8n:start           # lead hunter at http://localhost:5678
```

Real leads go in `data-riil`, never in `maju-bersama` — the seed rebuilds that
one and takes everything in it (known issue 7, decision 32).

`pnpm n8n:start` needs `N8N_ENCRYPTION_KEY` and `SORA_CAMPAIGN_ID` in
`.env.local`; compose fails with a named variable if either is missing. Full
setup in `docs/n8n-integration.md`.

---

## Known issues

1. **Drizzle bypasses RLS.** `src/lib/db/drizzle.ts` connects with `DATABASE_URL`, a
   privileged role. RLS protects the Supabase-client path only. Every Drizzle
   query must filter by `workspace_id` in application code — a missing filter is
   a security bug, not a style nit. Flagged in the file header comment, and
   pinned by an integration test that documents the bypass. Revisit if we later
   want `SET LOCAL role` per request.
2. ~~**No workspace creation path.**~~ **Closed 2026-08-28** — `/app` renders a
   create form for a user with no membership.
3. **`listUsers({ perPage: 1000 })` does not paginate.** Two callers now:
   `scripts/seed.ts` and `listMembersWithEmail()` in `src/lib/auth/members.ts`. Fine
   for a dev seed and a handful of members; fix with the invite flow.
4. **Every screen inside a workspace is still read-only.** Workspace creation is
   now the one mutation the UI can make; everything after it — approve/reject on
   Persetujuan, editing a lead, creating a campaign — is still unwritable. The
   webhook writes, but nothing behind `/app/{workspace}/…` does.
5. **Imported leads are invisible until a screen shows them.** Ingestion writes
   companies, contacts and leads that the existing Leads screen renders, but there
   is no import history view and no way to see a rejection after the fact — the
   `rejected[]` array only exists in the HTTP response. `webhook_events` stores the
   payload, so nothing is lost; it is just not surfaced.
6. **`normalizePhone` peels a repeated `62` prefix.** Right for a doubled country
   code, which occurs in scraped data; wrong for a hypothetical landline whose
   area code is literally `62`, which is not in Indonesia's numbering plan.
   Documented in the function.
7. **Running the integration suite silently destroys anything imported into
   `maju-bersama`.** Corrected 2026-08-28 — the first version of this entry said
   `pnpm test:integration` would *fail* on the seed's exact counts until a reset.
   It does not. `scripts/seed.ts:689` deletes the workspace row and lets the
   cascade take every domain table with it before rebuilding, and
   `tests/integration/seed.test.ts` runs that seed in `beforeAll`. So the counts
   are always correct by the time they are asserted, and the suite passes — after
   quietly throwing away every real lead in that workspace. Loud failure would
   have been the kinder outcome. The fix is a separate workspace for real
   imports; provisioning (done) is half of it, and the other half is a way to
   create a campaign, since the webhook resolves its workspace from
   `campaign_id`. Until then, treat anything imported into `maju-bersama` as
   disposable.

   **Closed 2026-09-01.** Both halves now exist — `pnpm workspace:create` and
   `pnpm campaign:create` — and the real import lives in `data-riil`. Verified
   the way this entry always wanted: a full `pnpm db:seed` plus
   `pnpm test:integration` (52 passed) with 10 real leads in place, all 10 still
   there afterwards. The seed only ever deletes the workspace it created.

   It is closed by **convention, not by code** (decision 32): running
   `pnpm campaign:create` with no `--workspace` on a machine where only
   `maju-bersama` exists still points real imports at the workspace the seed
   destroys. Nothing stops that but reading the flag.

8. **The Google free tier is not a production data path.** Google uses free-tier
   API data to improve its products; the paid tier does not. Acceptable while the
   prompts contain nothing but business names scraped from Google Maps. **Not**
   acceptable once a real customer's data is in a prompt, which happens at Module 5
   (content generation reads `knowledge_docs` and thread history). Moving to a paid
   key — or an equivalent no-training arrangement — is a launch blocker for that
   module, not a nice-to-have. Nothing in code enforces this today.

9. **A model call takes 5–25 seconds, and the variance is the problem.** Measured
   on `gemini-3.7-flash` for a two-field answer: 24.6s, 5.3s, 22.2s, with 131–289
   output tokens spent thinking. Scoring the 14 leads in `data-riil` one at a time
   would therefore take somewhere between one and six minutes, which is fine for a
   background job and unusable for a request-response UI. Module 3 must run through
   a queue, not a button that waits. Capping
   `providerOptions.google.thinkingConfig.thinkingBudget` is the first lever to try
   and would cut cost at the same time.

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
| 26 | The n8n secret lives in a `SORA Config` Set node, not `$env` | n8n Cloud blocks `$env` in Code nodes (`N8N_BLOCK_ENV_ACCESS_IN_NODE` defaults true, no Cloud override), so the documented approach could not work on the deployment we actually use. A Set node works on Cloud and self-hosted alike. `$vars` is better where the plan has it, and the Code node reads config from one place so switching is a one-line change. |
| 27 | The unanswered "duplicate company in a different campaign" question stays unanswered, and the current behaviour stands | Asked 2026-08-26, not answered by 2026-08-28. Per CLAUDE.md §4 the simplest option wins: SPEC's literal "on duplicate: don't insert" remains implemented, so a company found for campaign A gets no lead when campaign B targets it. Revisit before running a second campaign over the same city. |
| 28 | The create-workspace form lives on `/app`, not `/app/new` | A literal segment under `/app` is resolved by Next.js before the `[workspace]` dynamic one, so `/app/new` would make any workspace slugged `new` permanently unreachable — the exact collision `.claude/rules/structure.md` exists to prevent. `/app` already redirects anyone who has a workspace, so the form is only reachable by someone with none. `slug.ts` reserves the word anyway, belt and braces. |
| 29 | `slugifyWorkspaceName` delegates legal-form stripping to `normalizeCompanyName` | "PT Maju Bersama" → `maju-bersama` needs the same judgement dedupe already makes about what a company is really called. A second copy would drift from the first, which is the reasoning behind decision 23. The known limitation is inherited too: `P.T. Maju` keeps the dotted prefix, pinned by a test rather than fixed, because widening that regex would change fuzzy matching. |
| 30 | Workspace provisioning ships without campaign creation, and therefore does not close known issue 7 | Owner decision, 2026-08-28. CLAUDE.md §4 is one vertical slice at a time. It does mean the issue stays open: the n8n webhook resolves its workspace from `campaign_id`, so a fresh workspace with no campaign cannot receive an import, and real imports still have nowhere to go but the seeded workspace. |
| 31 | The n8n workflow and its container are committed to the repo | The previous copy lived only in one laptop's Docker volume and died with it, taking three nodes of wiring with it. A workflow that cannot be restored by `git clone` is a single point of failure wearing an integration's clothes. Secrets stay out of the JSON by reading them from the container environment, which is what makes committing it possible at all. |
| 32 | Real leads are kept out of `maju-bersama` by convention, not by code | The seed owns that workspace and deletes it on every run (known issue 7). Teaching the seed to spare rows it did not create would cost it the determinism every count assertion depends on. So the answer is a second workspace for real imports — provisioning already creates one for a membership-less user, so it needs no new code, only the discipline to pass `--workspace` to `pnpm campaign:create`. |
| 33 | `agent.ts` was brought forward ahead of slice 3b (CSV upload) | Owner decision, 2026-09-04. Ingestion already works and is feeding real leads; CSV would be a second door into a pipeline whose far end is still closed. Nothing downstream — enrichment, scoring, generation — can start without the LLM entry point, so it is the change that unblocks the most. 3b keeps its approved parser and its place in the queue. |
| 34 | The retry and escalation decisions live in `policy.ts`, not inside `agent.ts` | `agent.ts` must import `server-only` and the Drizzle handle, and `drizzle.ts` reads `DATABASE_URL` at module load — so the unit suite cannot import it without the database URL `.claude/rules/testing.md` says it must live without. The branches with real money and real latency behind them belong where they can be tested exhaustively for free. `policy.ts` calls no model, so rule 2 is intact. Same reasoning as decision 24. |
| 35 | Failures are classified by error *shape*, not by `instanceof` | The AI SDK's `APICallError` carries `statusCode`, `isRetryable` and `responseHeaders`; matching on those means a wrapped, re-thrown or scripted error is classified identically to a real one. That is what makes every failure path testable without a provider — and a provider will not produce a 429 on request. |
| 36 | The `ai_runs` write is best-effort, a deliberate exception to rule 10 | A Postgres hiccup must not discard a generation the provider was already paid for. The row is the record of a call, not the product of one; losing it is strictly better than losing the answer. Logged loudly so a systematic failure is visible rather than silent. |
| 37 | `ai_runs.cost_usd` records the paid-tier rate even on a free-tier key | The column exists to answer "what does this cost at volume". Recording the free tier's zero answers nothing and becomes quietly wrong the day the key changes, with no signal that it did. |
| 38 | The primary model is **`gemini-3.7-flash`**, replacing `gemini-2.5-flash` | Owner decision, 2026-09-04, forced rather than chosen: Google closed 2.5-flash to new API keys and the first real call returned 404. Candidates were probed directly, because `ListModels` still lists the dead one. `3.8-flash` was picked first and reversed on evidence — it returned 503 on 2 of 8 calls where `3.7-flash` returned 8 of 8, at the same price and the same free tier. A moving alias like `gemini-flash-latest` was rejected outright: SPEC §4 wants scores comparable over time, and a model that changes without a diff makes that impossible. |
| 39 | `DEFAULT_TIMEOUT_MS` is 60s, not 30s | Measured, not guessed. Three real calls for a two-field answer took 24.6s, 5.3s and 22.2s, because `gemini-3.7-flash` spends output tokens thinking and how long that takes varies wildly. 30s would have manufactured `timeout` failures out of ordinary calls. Capping the thinking budget is the other lever and belongs to Module 3, which is the module that knows how much reasoning a score is worth. |

### Dependencies added beyond the CLAUDE.md §1 stack table

Approved with the Phase 0 plan: `server-only` (makes rule 6 a build error),
`typescript-eslint` (makes rule 9 a lint error), `sonner` (toast), `tsx` (runs
`scripts/seed.ts`), `dotenv` (env for drizzle-kit and scripts), `tw-animate-css`
(required by the shadcn components we generated).

Added in Phase 1: `supabase` (the CLI, dev dependency — runs the local Postgres
the integration suite tests against).

`pnpm` itself was installed globally via npm — `corepack enable` failed with
EPERM against `C:\Program Files\nodejs`.
