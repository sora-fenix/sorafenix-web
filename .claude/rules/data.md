# Rule: data layer

Read before touching `src/lib/db/**`, `drizzle/**`, or any query.

## The one that bites: RLS does not protect the Drizzle path

`src/lib/db/drizzle.ts` connects with `DATABASE_URL`, a privileged role that
**bypasses Row Level Security**. RLS (`drizzle/0001_rls.sql`, `0003_rls_domain.sql`)
protects the Supabase-client path used by the browser. It does not protect this one.

Therefore: **every query written against the Drizzle handle must filter by
`workspace_id` explicitly.** A missing workspace filter is a security bug, not a
style nit — it leaks one tenant's data to another. `tests/integration/rls.test.ts`
pins this with a `privileged connection` case.

## Which client to use

| Client | Use for | Enforces RLS |
|---|---|---|
| `src/lib/db/drizzle.ts` | server-side reads and writes in `lib/` | no — filter manually |
| `src/lib/db/server.ts` | Supabase client in RSC / server actions | yes |
| `src/lib/db/browser.ts` | Supabase client in client components | yes |
| `src/lib/db/admin.ts` | service-role key: verified webhooks, cron, provisioning | no |

`admin.ts` may **never** be imported from a client component or an unauthenticated
route. The `server-only` import makes a violation a build error; do not remove it.

## Schema

- Every domain table has `workspace_id`, and RLS is enabled on every table.
- Schema is split by domain under `src/lib/db/schema/`. Import via the barrel
  `@/lib/db/schema`. Order is `workspace ← crm ← outreach`, `workspace ← ai`.
- drizzle-kit does **not** emit RLS policies. When you add a table, you add its
  policy by hand in a new migration and you say so in the PR body.

## Migrations

- `pnpm db:generate` writes the migration; commit it with the schema change in the
  same commit. Never edit a migration that is already committed.
- **Never run** `drizzle-kit push --force`, `TRUNCATE`, or `DROP` without asking
  the owner first. `.claude/settings.json` denies `drizzle-kit push` outright.
- `pnpm db:reset` rebuilds local Postgres from migrations plus the seed. It is
  safe locally and destructive anywhere else.

## Seed

`scripts/seed.ts` is deterministic and idempotent — UUIDv5 over a fixed namespace
plus a seeded RNG. Re-running it never duplicates rows, so tests can assert exact
counts and screenshots stay stable. Keep both properties when you extend it.

Every screen must be demo-able from the seed alone, with no external service.
