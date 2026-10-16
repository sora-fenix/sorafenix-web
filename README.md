# SORA

An AI sales agent platform for B2B teams. Multi-tenant SaaS.

SORA finds leads, enriches and scores them, drafts outreach for a human to
approve, sends it over email and WhatsApp, follows up, reads the replies and
keeps the CRM up to date:

```
Find → Enrich → Qualify → Store → Generate → Approve → Contact → Follow-up → Read Reply → Update CRM → Analyze
```

The AI proposes and a human approves. Nothing is sent without an approval, and
every outbound message passes a single send guard (opt-outs, daily limits,
cooldowns, quiet hours in the lead's local time).

## Stack

Next.js 15 (App Router, TypeScript strict) · Tailwind + shadcn/ui · Supabase
(Postgres, Auth, RLS) · Drizzle ORM · Zod · Vercel AI SDK · pg-boss · Gmail API ·
WhatsApp · n8n for lead scraping · Vitest + Playwright · pnpm.

## Running it locally

Requires Node.js, pnpm, Docker and the Supabase CLI.

```bash
pnpm install
cp .env.example .env.local   # then fill in the values
pnpm db:start                # local Supabase in Docker
pnpm db:reset                # migrations + deterministic seed
pnpm dev                     # http://localhost:3000
```

The seed makes every screen demo-able without any external service.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test   # the gate every change must pass
pnpm test:integration                      # needs the local database running
pnpm test:e2e                              # needs a dev server
```

## Documentation

| File | What it holds |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | MVP scope and data model — the build contract |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Current state, decisions and next steps |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deployment guide |
| [docs/n8n-integration.md](docs/n8n-integration.md) | How the n8n lead scraper talks to SORA |
| [docs/ADR/](docs/ADR/) | Architecture decision records |
| [CLAUDE.md](CLAUDE.md) | Engineering rules for contributors and AI agents |

## License

Proprietary. All rights reserved.
