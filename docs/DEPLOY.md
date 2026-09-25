# Deploying SORA to Vercel

Everything here is a step **the owner** takes. Nothing in this repository can log
into a Vercel or Supabase account, and nothing should try.

Read it once before starting. Three of the steps are ordered for a reason and
doing them out of order produces errors that look like something else entirely —
each one is called out below.

---

## 0. What you need first

| | Why |
|---|---|
| A **Supabase cloud project** | `.env.local` points at `127.0.0.1`. Those values are valid on this laptop and nowhere else. |
| The repo on **GitHub** | Vercel deploys from a git remote. |
| A **Vercel account** | Free Hobby tier is enough to start. |

`vercel.json` pins the functions to `sin1` (Singapore) — the closest region to
Indonesia, and the one that keeps the round trip to a Supabase project in
Southeast Asia short. Change it if the database ends up elsewhere: an app in
Singapore talking to a database in Virginia pays that distance on **every** query.

---

## 1. Supabase cloud

### 1a. Create the project

Pick a region near the users, not near you. **Singapore (`ap-southeast-1`)** is the
right default for an Indonesian sales team.

Save the database password Supabase shows you at creation. It appears once, and it
is part of `DATABASE_URL`.

### 1b. Run the migrations — before the first deploy

This is the step whose ordering matters most. The app expects 18 migrations'
worth of tables, policies and functions (`0000`-`0010`). Deploy first and every page returns 500
with a relation-does-not-exist error that reads like a code bug.

From this laptop, temporarily pointing at the cloud database:

```powershell
# The DIRECT connection string, not the pooled one. See 1c.
$env:DATABASE_URL = "postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres?sslmode=require"
pnpm db:migrate
```

PowerShell, because that is the shell here — `VAR=value command` is bash syntax
and does something else entirely on Windows.

`drizzle.config.ts` loads `.env.local` through dotenv, which does **not** overwrite
a variable that is already set, so the value above wins for as long as that shell
session lives. Closing the window puts everything back to local, and `.env.local`
is never touched.

Then confirm, against the same URL:

```sql
select count(*) from drizzle.__drizzle_migrations;  -- expect 18 (0000-0017)
select tablename from pg_tables where schemaname = 'public' order by 1;
select relname, relrowsecurity from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r';  -- every row true
```

**Do not run `pnpm db:seed` against production.** The seed creates a demo
workspace, three fake Supabase auth users and fabricated leads and scores. It is
built for a local demo and there is no supported way to unpick it from a real
database afterwards.

### 1c. Two connection strings, and they are not interchangeable

Supabase gives several. Two matter, and using the wrong one fails in a way that
looks unrelated:

| Use | Which | Port |
|---|---|---|
| **The app** (`DATABASE_URL` on Vercel) | Transaction pooler | 6543 |
| **Migrations** (`pnpm db:migrate`) | Direct connection | 5432 |

The app runs on serverless functions, which come and go constantly; the pooler is
what keeps that from exhausting Postgres connections. `src/lib/db/drizzle.ts`
already sets `prepare: false`, which the transaction pooler requires.

Migrations must **not** go through the transaction pooler. drizzle-kit takes
advisory locks and runs DDL that needs one session throughout, and the pooler
hands out a different backend per statement. The failure is a lock or syntax error
midway, with some migrations applied and some not.

Both need `?sslmode=require` appended.

### 1d. Auth URLs

**Authentication → URL Configuration:**

- **Site URL**: `https://your-app.vercel.app`
- **Redirect URLs**: add `https://your-app.vercel.app/auth/callback`

Login is a magic link. It is built from `NEXT_PUBLIC_APP_URL`
(`src/app/(auth)/login/actions.ts`) and Supabase refuses to send to a URL that is
not on that list. A mismatch produces a link that lands on an error page, or one
that silently redirects to `localhost:3000` in the user's email — which looks like
a broken deploy and is a two-field fix here.

### 1e. Keys

**Project Settings → API Keys.** Supabase's current format:

| Key | Goes into |
|---|---|
| `sb_publishable_…` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `sb_secret_…` | `SUPABASE_SERVICE_ROLE_KEY` |

The variable names are historical; `src/lib/env.ts` validates both as non-empty
strings and never as a JWT, so either key format parses.

`SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy. It is only ever read by
`src/lib/db/admin.ts`, which carries a `server-only` import so a client component
importing it is a build error. Never add it as a `NEXT_PUBLIC_*` variable.

---

## 2. Vercel

### 2a. Import

New Project → import the GitHub repo. Vercel detects Next.js and pnpm on its own;
`vercel.json` supplies the rest. Do not deploy yet — set the variables first, or
the build fails at boot (see 2c).

### 2b. Environment variables

Set these for **Production** (and Preview, if previews should work — see the
caveat below).

**Required — the app will not boot without all six:**

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://PROJECT.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `sb_publishable_…` key |
| `NEXT_PUBLIC_APP_URL` | `https://your-app.vercel.app` — the deployed URL, exactly |
| `DATABASE_URL` | transaction pooler string, port 6543, `?sslmode=require` |
| `SUPABASE_SERVICE_ROLE_KEY` | the `sb_secret_…` key |
| `N8N_WEBHOOK_SECRET` | 32+ random characters; must equal what n8n signs with |

**Optional — each becomes required when its module ships:**

`GOOGLE_GENERATIVE_AI_API_KEY` (lead scoring by model — `pnpm score:leads`;
deterministic classification needs no key), `OPENAI_API_KEY` (fallback model),
`GMAIL_*`, `WHATSAPP_*`, `SERPER_API_KEY`.

Leave an unused optional variable **unset**. Do not set it to `""`: Zod's
`.optional()` accepts `undefined` and rejects the empty string, so a blank
placeholder crashes the boot that rule 1 makes deliberately fatal.

The three `NEXT_PUBLIC_*` values are **baked into the bundle at build time**, not
read at runtime. Changing one in the Vercel dashboard does nothing until the next
deploy — redeploy after editing them, or the app keeps using the old value while
the dashboard shows the new one.

### 2c. A missing variable stops the deploy, on purpose

`src/instrumentation.ts` calls `serverEnv()` when the server starts, so a missing
or malformed variable kills the process immediately with a message naming the
field — rather than serving a half-working app that fails on whichever page first
touches the database. If a deploy dies at startup, read the build log: the answer
is in it verbatim.

### 2d. Preview deployments

Every preview gets its own URL, which `NEXT_PUBLIC_APP_URL` will not match. Magic
links from a preview therefore land on production. Either accept that previews
cannot complete a login, or add each preview URL to the Supabase redirect list —
there is no third option that does not involve a wildcard nobody should add to an
auth allowlist.

---

## 3. After the first deploy

### 3a. Point n8n at the deployed app

`docker-compose.n8n.yml` carries **two** SORA URLs, both pointing at this laptop.
Change both and recreate the container (`pnpm n8n:stop && pnpm n8n:start`):

| Variable | Production value |
|---|---|
| `SORA_WEBHOOK_URL` | `https://your-app.vercel.app/api/webhooks/n8n/leads` |
| `SORA_PLAN_URL` | `https://your-app.vercel.app/api/webhooks/n8n/plan` |

`SORA_PLAN_URL` is the one that decides the sweep: since ADR 0001 the workflow
asks SORA what to search rather than holding a keyword list of its own, so a
workflow pointed at a production app and a *stale* plan URL will happily sweep
against the laptop and post the results nowhere useful. There is no
`SORA_CAMPAIGN_ID` any more — every plan item names its own campaign.

`N8N_WEBHOOK_SECRET` must be identical on both sides. The HMAC is verified over
the exact request body, so a mismatched pair fails **every** delivery with
`401 invalid_signature` — which looks like a broken webhook rather than a
mismatched secret.

This is the natural moment to do the rotation in known issue 15, since both sides
are being touched anyway.

### 3b. Create the production workspace and campaign

The cloud database is empty, and **the first workspace is created in the browser,
not from a script.**

Sign in with a magic link and `/app` shows a create-workspace form
(`src/app/app/page.tsx`). That path exists because `drizzle/0001_rls.sql` gives
`workspaces` no INSERT policy, and `memberships_insert_admin` requires the caller
to already hold owner or manager in the target workspace — so a creator's own
first membership row is unreachable from the browser by construction, not by
oversight. `provisionWorkspace` writes the workspace and that membership in one
server-side transaction.

`pnpm workspace:create` cannot do this job. It takes `--members-from <slug>` and
copies memberships from a workspace that already has some; it is for the second
workspace, not the first.

The campaign and the product do come from scripts, in the same PowerShell session
as 1b:

```powershell
$env:DATABASE_URL = "<direct connection string>"
pnpm campaign:create --workspace "<slug>" --name "..."
pnpm product:create  --workspace "<slug>" --name "..." --value-prop "..."
```

The campaign id goes **nowhere** — not into n8n, not into an environment
variable. Give the campaign a `campaigns.target` instead (ADR 0001 §1) and the
plan endpoint starts including it in the daily sweep on its own. That is the
whole onboarding step for a new client.

The product is the real offer, not the `[DUMMY]` one in `data-riil` (known issue
21). Nothing may be sent quoting a price that does not exist.

### 3c. Verify, in this order

1. `GET https://your-app.vercel.app/api/health` → 200.
2. Open `/login`, request a magic link, and check the URL **inside the email** —
   it should be your Vercel domain, not `localhost`.
3. Sign in; `/app` should redirect into the workspace.
4. Open Prospek. It should paginate and state a real total.
5. Download the CSV and open it in Excel: semicolons split into columns, ratings
   read as numbers, `+62` numbers intact.
6. Run the n8n workflow once. Two things must hold, in this order: **Get Plan**
   returns items rather than `401 invalid_signature` — that proves
   `SORA_PLAN_URL` and the shared secret are both right — and then **Send to
   SORA** answers `accepted`. A plan that returns `item_count: 0` with entries
   in `skipped` is not a failure: it means every campaign was already planned
   today, out of budget, or has no `target` yet. Read the reason before
   debugging anything.
7. Check `scrape_cursors` moved: `position` should have advanced by exactly the
   number of items the plan issued. If items came back but the cursor did not
   move, the plan was a replay of one already issued today.

---

## 3d. What actually bit, on the first real run (2026-09-25)

This guide was written from the code on 2026-09-16 and executed for the first
time on 2026-09-25. Four things cost real time, and none of them were in it.

**Supabase renamed the keys, and the dashboard's names are not the code's.**
Copying the block Supabase offers verbatim gives you `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `SUPABASE_JWKS_URL`. The
app wants:

| Supabase calls it | Set it in Vercel as | Note |
|---|---|---|
| `SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_URL` | the `NEXT_PUBLIC_` prefix is what bakes it into the browser bundle |
| `SUPABASE_PUBLISHABLE_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same value, old name |
| `SUPABASE_SECRET_KEY` | `SUPABASE_SERVICE_ROLE_KEY` | same value, old name |
| `SUPABASE_JWKS_URL` | — | unused; `env.ts` knows nothing about it |

Renaming in Vercel means **delete and re-create**. Editing a variable changes its
value, not its name.

**A missing `NEXT_PUBLIC_*` fails the build as `Failed to collect page data for
/auth/callback`,** which names neither the variable nor the cause. `publicEnv` in
`src/lib/env.ts` is a module-scope const, so it is evaluated the moment any route
importing it is loaded — and `next build` loads every route. The real message is
printed far above that line:

```
Invalid public environment variables:
  - NEXT_PUBLIC_SUPABASE_ANON_KEY: NEXT_PUBLIC_SUPABASE_ANON_KEY is required
```

Search the build log for `Invalid public environment variables` rather than
reading the stack trace at the bottom.

**Supabase's Site URL silently overrides a redirect that is not allowlisted.**
Symptom: the magic link works, but the email's link points somewhere else
entirely — in our case `https://<project>-<team>.vercel.app/`, with no
`/auth/callback` path, and that host is behind Vercel's own login wall. Supabase
does not report the rejection; it falls back to Site URL. Both fields must be set
under **Authentication → URL Configuration**:

- **Site URL**: `https://your-app.vercel.app`
- **Redirect URLs**: `https://your-app.vercel.app/**`

The wildcard matters: the callback carries `?next=/app`.

**Special characters in the database password must be percent-encoded** in
`DATABASE_URL`. A `&` is a query separator and truncates the string inside the
driver; `LM!Cn&hFJ...` has to be written `LM!Cn%26hFJ...`. The failure is
`ERR_INVALID_URL` or a connection that silently uses the wrong credentials.

### If `pnpm db:migrate` cannot reach the database at all

Some networks block outbound TCP on 5432/6543 while allowing HTTPS. The fallback
that works everywhere: concatenate every file in `drizzle/` in journal order into
one script, append the `drizzle.__drizzle_migrations` bookkeeping rows (hash and
`created_at` copied from a database where the chain is already applied), wrap it
in `begin; ... commit;`, and paste it once into the Supabase SQL Editor.

Verify it on a throwaway database first — `create database`, add a stand-in for
`auth.users` and `auth.uid()`, apply, compare the schema, drop it. None of the
18 migrations contains a statement that cannot run inside a transaction, so the
wrapper is safe and an error leaves nothing behind.

---

## 4. Things that will bite later

- **Connection pool.** `drizzle.ts` opens up to 10 connections per instance. One
  laptop is fine; a hundred concurrent serverless functions through the pooler is
  a different shape. Lower `max` before it matters, not after.
- **No cron yet.** SPEC §7 wants `/api/cron/sequences` every 5 minutes. Neither
  the route nor a `crons` entry in `vercel.json` exists — add both in the slice
  that builds the runner, not before.
- **Backups.** Supabase's free tier keeps a short retention window. The 1208
  scraped leads are a week of real work and a Serper budget; treat the export
  endpoint as a manual backup until a real one is configured.
- **Nothing sends.** There is no email or WhatsApp adapter, so a production deploy
  today can scrape, classify and display, and cannot contact anyone. That is the
  intended state — the send guard exists precisely so no send path predates it.
