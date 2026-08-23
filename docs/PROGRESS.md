# SORA — Progress

Current state and next steps. Updated after every task, per CLAUDE.md §3.

**Last updated:** 2026-08-23
**Phase:** 1 — Data layer + read-only CRM (schema, RLS, seed, all nine screens)

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
| `pnpm lint` | ✅ clean (0 errors, 0 warnings) |
| `pnpm test` | ✅ 17 tests, 2 files |
| `pnpm test:integration` | ✅ 22 tests, 2 files (needs `pnpm db:start`) |
| `pnpm build` | ✅ 17 routes |
| `pnpm test:e2e` | ⏸️ written, not run — Playwright browsers not installed |

---

## Done

### Tooling
- Next.js **15.5.23** (App Router, RSC by default), React 19.2.8, TypeScript
  `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
- Tailwind v4 + shadcn/ui (new-york, neutral), generated into `components/ui/`
  and treated as vendor code. `badge`, `card`, `table` added in this phase.
- ESLint flat config. `no-explicit-any`, `no-non-null-assertion`, and
  `consistent-type-assertions: never` are **errors** on our code — CLAUDE.md
  rule 9 is enforced by the linter, not by review. `components/ui/**` and the
  Supabase CLI scratch directories are exempt.
- Vitest runs two suites: `tests/unit` (pure, default config) and
  `tests/integration` (real Postgres, `vitest.integration.config.ts`, file
  parallelism off because the seed rebuilds a shared workspace).

### Environment (rule 1)
- `lib/env.ts` is the only file in the codebase that reads `process.env`.
  The single exception is `instrumentation.ts` reading `NEXT_RUNTIME`, a Next
  runtime discriminator, not app config.
- `instrumentation.ts` calls `serverEnv()` in `register()`, so a missing
  variable kills the process **at boot**.
- `.env.local` points at the local Supabase stack using the **new** Supabase key
  format: `sb_publishable_…` replaces the anon JWT, `sb_secret_…` replaces the
  service_role JWT. Variable names are unchanged — only the value shape is.
  `lib/env.ts` needed no edit for this: it validates both keys as
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
- `lib/db/schema.ts` split into `lib/db/schema/` — `workspace.ts`, `crm.ts`,
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
- `lib/db/queries/dashboard.ts` — stats, funnel, due-lead queue, recent
  activities, pending approvals, new leads this month.
- `lib/db/queries/records.ts` — list functions for leads, companies, contacts,
  campaigns, inbox, approvals, knowledge docs, members, integrations,
  suppressions, product count.
- Every function takes `workspaceId` and filters on it. This is load-bearing,
  not stylistic: Drizzle connects privileged and bypasses RLS (known issue 1).

### UI
- Dashboard reads live data: stat cards, funnel, due-lead queue with overdue
  marking, recent activity feed, pending approval count.
- Leads list reads live data: table with status and score-category badges.
- The other seven screens are wired to `lib/db/queries/records.ts`, all following
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
- `lib/auth/members.ts` joins `memberships` to Supabase Auth: `memberships`
  stores only `user_id`, so `listMembersWithEmail()` resolves emails through
  `lib/db/admin.ts`. Allowed under rule 6 — `admin.ts` is `server-only` and the
  caller renders under the authed workspace layout. Degrades to `email: null`
  rather than throwing when the auth call fails.
- `components/layout/module-placeholder.tsx` deleted; nothing imported it once
  the last screen was wired.
- `components/crm/labels.tsx` holds the shared Indonesian labels and badges
  (lead status, activity type, actor, score category). `lib/format.ts` holds
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
- `app/app/[workspace]/layout.tsx` does the membership check. A non-member and a
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

---

## Next up

Recommended order. One vertical slice at a time (schema → server logic → API →
UI → test), nothing started until the previous slice is green.

1. **Workspace provisioning** — create a workspace on first sign-in, or an
   invite flow. A brand-new user still lands on "Anda belum punya workspace" and
   can only be rescued by `pnpm db:seed`.
2. **Module 1 — lead ingestion.** `POST /api/webhooks/n8n/leads`, HMAC
   verification, `webhook_events` idempotency, `lib/leads/dedupe.ts` (unit
   tested: domain → phone → email → fuzzy name+city). Tables already exist.
3. **Module 3 — qualification.** `lib/ai/agent.ts` + `ai_runs` first, then
   `lib/scoring/rubric.ts`. The model returns per-factor sub-scores only; code
   computes the weighted total. The seed already writes rows in that shape.
4. **Module 5 + approvals** — content generation with `needs_input` gating.
5. **`lib/outreach/send-guard.ts`** — before any provider adapter exists, so
   there is never a code path that sends without it.

---

## Blocked

| Item | Needs |
|---|---|
| `pnpm test:e2e` | `pnpm exec playwright install chromium` (~150 MB download). Deliberately not run. |

**To run the stack from scratch:**

```
pnpm db:start            # Supabase CLI (Docker)
pnpm db:reset            # recreate, apply 0000-0003, seed
pnpm dev                 # sign in at /login, mail lands in Inbucket
```

---

## Known issues

1. **Drizzle bypasses RLS.** `lib/db/drizzle.ts` connects with `DATABASE_URL`, a
   privileged role. RLS protects the Supabase-client path only. Every Drizzle
   query must filter by `workspace_id` in application code — a missing filter is
   a security bug, not a style nit. Flagged in the file header comment, and
   pinned by an integration test that documents the bypass. Revisit if we later
   want `SET LOCAL role` per request.
2. **No workspace creation path.** Covered as next-up item 1.
3. **`listUsers({ perPage: 1000 })` does not paginate.** Two callers now:
   `scripts/seed.ts` and `listMembersWithEmail()` in `lib/auth/members.ts`. Fine
   for a dev seed and a handful of members; fix with the invite flow.
4. **Every screen is read-only.** No forms, server actions, or mutations exist
   anywhere in the product yet — including approve/reject on Persetujuan.

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

### Dependencies added beyond the CLAUDE.md §1 stack table

Approved with the Phase 0 plan: `server-only` (makes rule 6 a build error),
`typescript-eslint` (makes rule 9 a lint error), `sonner` (toast), `tsx` (runs
`scripts/seed.ts`), `dotenv` (env for drizzle-kit and scripts), `tw-animate-css`
(required by the shadcn components we generated).

Added in Phase 1: `supabase` (the CLI, dev dependency — runs the local Postgres
the integration suite tests against).

`pnpm` itself was installed globally via npm — `corepack enable` failed with
EPERM against `C:\Program Files\nodejs`.
