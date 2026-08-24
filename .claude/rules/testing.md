# Rule: testing

Read before writing a test, or before claiming a slice is done.

## What must have unit tests

Non-negotiable — these are pure functions carrying the product's risk:

- `src/lib/scoring/*`
- `src/lib/outreach/send-guard.ts`
- `src/lib/leads/dedupe.ts`
- `src/lib/sequences/state-machine.ts`
- `src/lib/ai/classify-reply.ts`

UI components do not need unit tests in the MVP. Do not write them.

## The suites

| Command | Covers | Needs |
|---|---|---|
| `pnpm test` | `tests/unit/**` — pure logic, no I/O | nothing |
| `pnpm test:integration` | `tests/integration/**` — real Postgres, RLS, seed | Docker + `pnpm db:start` |
| `pnpm test:e2e` | `tests/e2e/**` — 2–3 smoke flows only | a dev server |

The unit suite gets its own throwaway env values inside `vitest.config.ts`, so it
never depends on a developer's `.env.local`. Keep it that way.

Integration tests run with `fileParallelism: false` — the seed rebuilds a shared
workspace and parallel files would race on it.

## The gate

Before moving to the next phase or slice:

```
pnpm typecheck && pnpm lint && pnpm test
```

All three green, or the slice is not done. Report the actual output. A test that
fails is a result to state plainly, never something to work around by loosening
the assertion, adding a `skip`, or widening a type.

If a command cannot run at all in the current environment, say so explicitly and
name what was verified instead. Never imply a suite passed when it did not run.

## Writing tests

- Assert exact counts where the seed is deterministic — it is designed for that.
- Test the rejection paths of `send-guard.ts` one by one, including their order.
- A bug fix comes with the test that would have caught it.
