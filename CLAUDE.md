# SORA — AI Sales Agent Platform

Multi-tenant SaaS. Core loop:
`Find → Enrich → Qualify → Store → Generate → Approve → Contact → Follow-up → Read Reply → Update CRM → Analyze`

Product spec: `docs/SPEC.md`. Current state & next steps: `docs/PROGRESS.md`.
Read both before starting any task.

---

## 1. Stack (do not change without asking me first)

| Layer | Choice |
|---|---|
| Framework | Next.js 15 App Router, TypeScript `strict`, RSC by default |
| UI | Tailwind + shadcn/ui + lucide-react |
| DB / Auth / Storage | Supabase (Postgres + Auth + Storage + RLS) |
| ORM & migrations | Drizzle ORM, migrations committed in `/drizzle` |
| Validation | Zod at every boundary |
| LLM | Vercel AI SDK. Primary `gemini-3.7-flash`, fallback `gpt-4.1-mini` |
| Background jobs | `pg-boss` on the same Postgres. No Redis, no external queue in MVP |
| Email / WhatsApp | Gmail API (OAuth per workspace) / WhatsApp Cloud API |
| Lead scraping | n8n stays external, talks to us via one signed webhook |
| Tests | Vitest (unit) + Playwright (2–3 smoke flows only) |
| Package manager | pnpm |

---

## 2. Non-negotiable rules

1. **No secrets in code.** Only `src/lib/env.ts` reads `process.env`. Missing var = crash at boot.
2. **All LLM calls go through `src/lib/ai/agent.ts`.** No provider `fetch` anywhere else.
3. **AI never invents facts.** Unknown → empty placeholder, flag the draft `needs_input`.
4. **Every outbound message passes `src/lib/outreach/send-guard.ts`.** No bypass path.
5. **Human-in-the-loop is the default.** AI proposes → human approves → system executes.
6. **Multi-tenant isolation.** `workspace_id` on every domain table, RLS on every table, service-role key only inside `src/lib/db/admin.ts`.
7. **Idempotency everywhere.** Every webhook and send takes an `idempotency_key`.
8. **Language split.** UI copy and user-facing errors in **Bahasa Indonesia**; code, comments, commits and docs in **English**.
9. **Type discipline.** No `any`, no `!`, no unchecked `as`. Fallible functions return `Result<T, E>`.
10. **Audit everything.** Lead status, score or owner changes write an `activities` row with `actor`.

Each rule is expanded, with the reasoning and the failure it prevents, in the rule
file for its area. Read the rule file before working in that area — not before.

## 3. Where the rules live

| Touching | Read first |
|---|---|
| `src/lib/db/**`, `drizzle/**`, any query | `.claude/rules/data.md` |
| `src/lib/ai/**`, anything calling a model | `.claude/rules/ai.md` |
| `src/lib/outreach/**`, `src/lib/sequences/**` | `.claude/rules/outreach.md` |
| `src/app/**`, `src/components/**` | `.claude/rules/ui.md` |
| tests, or claiming a slice is done | `.claude/rules/testing.md` |
| deciding where a file goes | `.claude/rules/structure.md` |
| committing | `.claude/rules/git.md` |

Read only the ones that apply.

**Roles** live in `.claude/agents/`: `pm`, `architect`, `engineer`, `qa`, `reviewer`.
**Commands**: `/slice <feature>` runs the pipeline, `/verify` runs the gate,
`/handoff` updates PROGRESS and commits.

---

## 4. How you should work

- **Plan first.** Anything touching more than one file: output a plan (files, schema
  changes, risks) and wait for my OK. Use plan mode.
- **One vertical slice at a time.** Schema → server logic → API → UI → test, for a
  single feature. Do not start the next phase until
  `pnpm typecheck && pnpm lint && pnpm test` all pass.
- **Ask before adding a dependency.** Name it, why, and what it replaces.
- **After every task**, update `docs/PROGRESS.md`: done, next, known issues, decisions.
- **Commits**: conventional, small, one logical change, with a `Role:` trailer.
- **If a requirement is ambiguous**, ask at most 3 questions. If I don't answer, pick
  the simplest option, state the assumption in `docs/PROGRESS.md`, and continue.
- **Don't gold-plate.** No abstraction for a second use case that doesn't exist yet.
- **Never** run destructive DB commands (`drizzle-kit push --force`, `TRUNCATE`,
  `DROP`) without asking.
- **Report honestly.** If a suite fails or could not run, say so and say what you
  verified instead.

## 5. Definition of done (per module)

- [ ] Drizzle schema + migration committed, RLS policy written
- [ ] Server logic in `src/lib/`, pure and unit-tested where `.claude/rules/testing.md` requires it
- [ ] API route validated with Zod, returns typed errors, rate-limited
- [ ] UI in Bahasa Indonesia, loading + empty + error states, works on mobile
- [ ] Seed data so the screen is demo-able without external services
- [ ] `typecheck`, `lint`, `test` green
- [ ] `docs/PROGRESS.md` updated
