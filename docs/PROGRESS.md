# SORA — Progress

Current state and next steps. Updated after every task, per CLAUDE.md §3.

**Last updated:** 2026-08-20
**Phase:** 0 — Scaffold (complete)

---

## Where we are

The foundation boots and is demo-able. No business logic exists yet, and no
domain tables have been created. Everything in `docs/SPEC.md` §2–§9 is still
ahead of us.

| Gate | Status |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ clean (0 errors, 0 warnings) |
| `pnpm test` | ✅ 17 tests, 2 files |
| `pnpm build` | ✅ 18 routes |
| `pnpm test:e2e` | ⏸️ written, not run — Playwright browsers not installed |

---

## Done

### Tooling
- Next.js **15.5.23** (App Router, RSC by default), React 19.2.8, TypeScript
  `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
- Tailwind v4 + shadcn/ui (new-york, neutral). 11 components generated into
  `components/ui/`, treated as vendor code.
- ESLint flat config. `no-explicit-any`, `no-non-null-assertion`, and
  `consistent-type-assertions: never` are **errors** on our code — CLAUDE.md
  rule 9 is enforced by the linter, not by review. `components/ui/**` is exempt.
- Vitest (unit, `tests/unit`) and Playwright (e2e, `tests/e2e`) configured.
- Scripts: `dev build start typecheck lint test test:watch test:e2e db:generate
  db:migrate db:studio db:seed`.

### Environment (rule 1)
- `lib/env.ts` is the only file in the codebase that reads `process.env`.
  Verified by grep; the single exception is `instrumentation.ts` reading
  `NEXT_RUNTIME`, which is a Next runtime discriminator, not app config.
- `instrumentation.ts` calls `serverEnv()` in `register()`, so a missing variable
  kills the process **at boot**. Verified by removing `N8N_WEBHOOK_SECRET` and
  starting the server: it fails with `N8N_WEBHOOK_SECRET is required`.
- `.env.example` documents every variable with its dashboard location.

### Data
- `lib/db/schema.ts`: `workspaces` + `memberships` + `membership_role` and
  `workspace_plan` enums. Nothing else.
- `drizzle/0000_lame_psylocke.sql` — generated tables.
- `drizzle/0001_rls.sql` — hand-written: FK to `auth.users`, two
  `SECURITY DEFINER` helpers (`is_workspace_member`, `has_workspace_role`) with
  a pinned `search_path`, and RLS enabled + forced on both tables.
- **Neither migration has been run.** No database has been touched.

### Auth
- Supabase magic link. Server action → `signInWithOtp` → `/auth/callback`
  exchanges the PKCE code → redirects to `?next=`.
- `?next=` accepts relative paths only (checked in three places: the login page,
  the server action's Zod schema, and the callback route). No open redirect.
- `middleware.ts` matches `/app/:path*`, refreshes the session with
  `getUser()` (not `getSession()` — that trusts the cookie), and redirects
  signed-out users to `/login?next=…` carrying refreshed cookies through.
- `app/app/[workspace]/layout.tsx` does the membership check. A non-member and a
  non-existent slug both get the same `notFound()`, so slugs cannot be probed.

### UI
- Sidebar (9 sections) + topbar with workspace switcher and user menu. Collapses
  to icons on desktop, to a sheet on mobile.
- All copy is Bahasa Indonesia; route slugs stay English.
- Every module page ships a designed empty state naming the module that will
  fill it. `loading.tsx`, `error.tsx`, `not-found.tsx` present.

---

## Next up

Recommended order. One vertical slice at a time (schema → server logic → API →
UI → test), nothing started until the previous slice is green.

1. **Unblock the database** (see Blocked below) — nothing else can be verified
   end to end until this is done.
2. **Workspace provisioning** — create a workspace on first sign-in, or an
   invite flow. Right now a brand-new user lands on "Anda belum punya workspace"
   and can only be rescued by `pnpm db:seed`.
3. **Module 1 — lead ingestion.** `POST /api/webhooks/n8n/leads`, HMAC
   verification, `webhook_events` idempotency, `lib/leads/dedupe.ts` (unit
   tested: domain → phone → email → fuzzy name+city). Brings in the `companies`,
   `contacts`, `campaigns`, and `webhook_events` tables.
4. **Module 3 — qualification.** `lib/ai/agent.ts` + `ai_runs` first, then
   `lib/scoring/rubric.ts`. The model returns per-factor sub-scores only; code
   computes the weighted total.
5. **Module 5 + approvals** — content generation with `needs_input` gating.
6. **`lib/outreach/send-guard.ts`** — before any provider adapter exists, so
   there is never a code path that sends without it.

---

## Blocked

| Item | Needs |
|---|---|
| `pnpm db:migrate` | A Supabase project. Migrations are written and committed but have never run. |
| Auth end to end | Same. Plus adding `http://localhost:3000/auth/callback` under Supabase → Authentication → URL Configuration → Redirect URLs. |
| `pnpm test:e2e` | `pnpm exec playwright install chromium` (~150 MB download). Deliberately not run. |

**To unblock:** create a Supabase project, replace the placeholder values in
`.env.local` with real ones (see `.env.example` for where each lives), then:

```
pnpm db:migrate          # applies 0000 + 0001
pnpm dev                 # sign in at /login
pnpm db:seed you@company.com   # after the first sign-in creates your auth user
```

---

## Known issues

1. **Drizzle bypasses RLS.** `lib/db/drizzle.ts` connects with `DATABASE_URL`, a
   privileged role. RLS protects the Supabase-client path only. Every Drizzle
   query must filter by `workspace_id` in application code — a missing filter is
   a security bug, not a style nit. Flagged in the file's header comment.
   Revisit if we later want `SET LOCAL role` per request.
2. **`.env.local` holds placeholder values**, so the app boots but cannot reach
   Supabase or Postgres. Any page that queries the database will error until
   real credentials are in place. This is expected in Phase 0.
3. **No workspace creation path.** Covered as next-up item 2.
4. **`listUsers({ perPage: 1000 })` in `scripts/seed.ts`** does not paginate.
   Fine for a dev seed, wrong for anything else.

---

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Authed URLs are `/app/{workspace}/…` with a literal `/app` segment | Middleware matcher is exactly `['/app/:path*']`, and a workspace slug can never shadow a marketing route. CLAUDE.md §4 updated to match; it previously implied `/{workspace}/…`. |
| 2 | Integration env vars are `.optional()` for now | Gmail/WhatsApp/LLM credentials do not exist yet; requiring them would mean nothing boots. Each is promoted to required in the phase that ships its module. Core vars (Supabase, `DATABASE_URL`, `N8N_WEBHOOK_SECRET`) are hard-required today. |
| 3 | Pinned **Next.js 15**, not 16 | `create-next-app` now emits Next 16.3.1, but CLAUDE.md §1 specifies Next 15 and says not to change the stack without asking. Pinned to 15.5.23. **Open question for the owner** — 16 is stable and this is the cheapest moment to move. |
| 4 | Server env exposed as `serverEnv()`, not a bare `env` const | `lib/env.ts` is imported by client components for `publicEnv`. A top-level server parse would throw in the browser. A function call keeps everything in one file (rule 1) with no `Proxy` and no type assertion. |
| 5 | RLS lives in a hand-written migration | drizzle-kit does not emit RLS policies, and the FK to `auth.users` must not tempt drizzle-kit into managing Supabase's `auth` schema. |
| 6 | `next-themes` removed | Pulled in transitively by shadcn's `sonner`. Rewrote `components/ui/sonner.tsx` to drop it rather than accept an unapproved dependency for a dark-mode toggle we have not built. |
| 7 | `typedRoutes` left off | It cannot type the dynamically built `/app/${slug}/${segment}` hrefs without a cast, and casts are banned by rule 9. |

### Dependencies added beyond the CLAUDE.md §1 stack table

Approved with the Phase 0 plan: `server-only` (makes rule 6 a build error),
`typescript-eslint` (makes rule 9 a lint error), `sonner` (toast), `tsx` (runs
`scripts/seed.ts`), `dotenv` (env for drizzle-kit and scripts), `tw-animate-css`
(required by the shadcn components we generated).

`pnpm` itself was installed globally via npm — `corepack enable` failed with
EPERM against `C:\Program Files\nodejs`.
