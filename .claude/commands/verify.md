---
description: Run the typecheck, lint and test gate and report the real output
---

Run the gate that CLAUDE.md requires before any slice or phase is considered done:

```
pnpm typecheck
pnpm lint
pnpm test
```

Run all three even if the first fails — the owner wants the full picture, not the
first error.

Then report:

- **PASS** or **FAIL** on one line.
- For each failure: the file, the message, and one sentence on the cause.
- What was *not* covered: `pnpm test:integration` needs Docker and `pnpm db:start`;
  `pnpm test:e2e` needs a dev server. Say plainly whether they ran.

If a command cannot run at all in this environment — node missing, dependencies
not installed — say so explicitly and name what you verified instead. Never imply
a suite passed when it did not run.

Do not fix anything. This command reports.
