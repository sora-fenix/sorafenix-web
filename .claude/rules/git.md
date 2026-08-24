# Rule: commits

Read before committing.

## Format

Conventional commits, in English, one logical change each. Role attribution goes
in the footer as trailers — the subject line stays clean.

```
feat(crm): add lead status transition

Status changes now go through lib/crm/status.ts, which writes the paired
activities row. Nothing else may write leads.status.

Role: engineer
Reviewed-by: qa
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Trailers

- `Role:` — who did the work: `pm` | `architect` | `engineer` | `qa` | `reviewer`.
  Exactly one. Required on every commit.
- `Reviewed-by:` — the role that verified it, when one did. Optional.

Read the trail back with:

```
git log --grep='^Role: engineer' --format='%h %s'
git log --format='%h %s%n    %(trailers:key=Role,valueonly)'
```

## Types

`feat` `fix` `refactor` `docs` `test` `chore` `perf`. Scope is the module:
`crm`, `env`, `db`, `outreach`, `ai`, `ui`, `structure`, `harness`.

## Body

Say **why**, not what — the diff already says what. If the change carries a
caveat (a suite that could not run, a known follow-up, a decision the owner
should revisit), it belongs in the body. Do not hide it.

## Rules

- Never `git push` unless the owner asks. `.claude/settings.json` denies it.
- Never `--no-verify` or skip signing.
- If on the default branch and the change is substantial, branch first.
- Prefer a new commit over amending one that already exists.
