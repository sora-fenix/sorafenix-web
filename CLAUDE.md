# SORA — AI Sales Agent Platform

Multi-tenant SaaS. Core loop:
`Find → Enrich → Qualify → Store → Generate → Approve → Contact → Follow-up → Read Reply → Update CRM → Analyze`

Full product spec: `docs/SPEC.md`. Current state & next steps: `docs/PROGRESS.md`.
Read both before starting any task.

---

## 1. Stack (do not change without asking me first)

| Layer | Choice |
|---|---|
| Framework | Next.js 15 App Router, TypeScript `strict`, RSC by default |
| UI | Tailwind + shadcn/ui + lucide-react |
| DB / Auth / Storage | Supabase (Postgres + Auth + Storage + RLS) |
| ORM & migrations | Drizzle ORM, migrations committed in `/drizzle` |
| Validation | Zod at every boundary (env, API, LLM output, webhooks, forms) |
| LLM | Vercel AI SDK. Primary `gemini-2.5-flash`, fallback `gpt-4.1-mini`. Model IDs live in `lib/ai/models.ts` only |
| Background jobs | `pg-boss` on the same Postgres. No Redis, no external queue in MVP |
| Email | Gmail API (OAuth per workspace) |
| WhatsApp | WhatsApp Cloud API (official Business Platform) |
| Lead scraping | n8n stays external. It talks to us **only** via one signed webhook |
| Tests | Vitest (unit) + Playwright (2–3 smoke flows only) |
| Package manager | pnpm |

---

## 2. Non-negotiable rules

1. **No secrets in code.** All env vars declared and parsed in `lib/env.ts` with Zod. App must crash at boot if a var is missing.
2. **All LLM calls go through `lib/ai/agent.ts`.** Typed Zod input/output, retry with backoff, timeout, and a row written to `ai_runs` (agent, model, tokens, cost, latency, ok/error). No `fetch` to a model provider anywhere else.
3. **AI must never invent facts.** Company details, prices, features, discounts, specs, delivery times — only from the DB or `knowledge_docs`. Unknown → leave the placeholder empty and flag the draft `needs_input`. Never guess.
4. **Every outbound message passes `lib/outreach/send-guard.ts`.** It checks, in order: suppression/opt-out list → workspace daily sending limit → per-contact cooldown → duplicate campaign send → approval status → quiet hours (local time of the lead). Any failure returns a typed rejection, never throws, never sends. There is no bypass path.
5. **Human-in-the-loop is the default.** AI proposes → human approves → system executes. `workspace.autonomous_mode` exists but ships `false` and is not wired to skip approval in MVP.
6. **Multi-tenant isolation.** Every domain table has `workspace_id`. RLS enabled on every table. Service-role key is used only inside `lib/db/admin.ts`, which may never be imported from a client component or an unauthenticated route.
7. **Idempotency everywhere.** Every webhook handler and every send operation takes an `idempotency_key` and is safe to replay. Store handled keys in `webhook_events`.
8. **Language split.** UI copy, emails to users, and error messages shown to users: **Bahasa Indonesia**. Code, identifiers, comments, commit messages, docs: **English**.
9. **Type discipline.** No `any`, no non-null `!`, no unchecked `as`. Fallible functions return `Result<T, E>`, they don't throw strings.
10. **Audit everything.** Any change to a lead's status, score, or owner writes an `activities` row with `actor: 'ai' | 'human' | 'system'`.

---

## 3. How you should work

- **Plan first.** For anything touching more than one file, output a plan (files to add/change, schema changes, risks) and wait for my OK. Use plan mode.
- **One vertical slice at a time.** Schema → server logic → API → UI → test, for a single feature. Do not start the next phase until `pnpm typecheck && pnpm lint && pnpm test` all pass.
- **Ask before adding a dependency.** Name it, say why, say what it replaces.
- **After every task**, update `docs/PROGRESS.md`: what's done, what's next, known issues, decisions made.
- **Commits**: conventional commits, small, one logical change each.
- **If a requirement is ambiguous**, ask at most 3 questions. If I don't answer, pick the simplest option, state the assumption in `docs/PROGRESS.md`, and continue.
- **Don't gold-plate.** No abstractions for a second use case that doesn't exist yet. No feature flags for features that aren't built.
- **Never** run destructive DB commands (`drizzle-kit push --force`, `TRUNCATE`, `DROP`) without asking.

### Tests are required for
`lib/scoring/*`, `lib/outreach/send-guard.ts`, `lib/leads/dedupe.ts`, `lib/sequences/state-machine.ts`, `lib/ai/classify-reply.ts`.
UI components do not need unit tests in MVP.

---

## 4. Directory layout

Authed URLs carry a literal `/app` prefix (`/app/{workspace}/dashboard`), so the
middleware matcher is exactly `['/app/:path*']` and a workspace slug can never
collide with a marketing route.

```
app/
  (marketing)/                 # landing, pricing            -> /  /pricing
  (auth)/
    login/                     # magic-link form + server action
    auth/callback/             # PKCE code exchange
    auth/error/
  app/                         # authed product
    page.tsx                   # -> redirects to first workspace
    [workspace]/               # -> /app/{slug}/...
      dashboard/ leads/ companies/ contacts/
      campaigns/ inbox/ approvals/ knowledge/ settings/
      layout.tsx loading.tsx error.tsx not-found.tsx
  api/
    health/                    # liveness check
    webhooks/n8n/leads/        # lead ingestion (HMAC signed)
    webhooks/gmail/            # push notifications
    webhooks/whatsapp/         # inbound + status callbacks
    cron/                      # queue tick, sequence tick
middleware.ts                  # session refresh + /app guard
instrumentation.ts             # boot-time env validation
components/
  ui/                          # shadcn, generated — treated as vendor code
  layout/                      # sidebar, topbar, workspace switcher, page shell
lib/
  env.ts                       # the ONLY file that reads process.env
  types/         result.ts
  db/            drizzle.ts schema.ts browser.ts server.ts admin.ts middleware.ts
  auth/          session.ts permissions.ts
  ai/            agent.ts models.ts prompts/ schemas/
  leads/         dedupe.ts enrich.ts
  scoring/       rubric.ts score.ts
  outreach/      send-guard.ts email.ts whatsapp.ts
  sequences/     state-machine.ts runner.ts
  crm/           status.ts activity.ts
drizzle/                       # migrations (0001_rls.sql is hand-written)
scripts/         seed.ts
docs/            SPEC.md PROGRESS.md ADR/
tests/           unit/ e2e/
```

---

## 5. Definition of done (per module)

- [ ] Drizzle schema + migration committed, RLS policy written
- [ ] Server logic in `lib/`, pure and unit-tested where listed above
- [ ] API route validated with Zod, returns typed errors, rate-limited
- [ ] UI in Bahasa Indonesia, loading + empty + error states, works on mobile
- [ ] Seed data so the screen is demo-able without external services
- [ ] `typecheck`, `lint`, `test` green
- [ ] `docs/PROGRESS.md` updated

---

## 6. Compliance guardrails (build these in, don't treat as optional)

- Outreach targets **business** contacts only (company email, office/business number). Never store or message a personal number scraped from a profile page without a lawful basis.
- WhatsApp: template messages only outside the 24-hour customer service window; honour opt-in; a "STOP"/"jangan hubungi" reply writes to `suppressions` immediately and stops every sequence for that contact.
- Email: every outbound has List-Unsubscribe headers and a working unsubscribe link; bounces suppress the address.
- `suppressions` is checked before *every* send, not just at campaign build time.
- Data deletion: a workspace owner can export and hard-delete all contact data (UU PDP 27/2022 obligation).
