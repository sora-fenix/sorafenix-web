---
description: Update PROGRESS.md and commit the finished work with role trailers
argument-hint: [role, defaults to engineer]
---

Close out the work that is currently in the working tree.

1. **Check the gate first.** `pnpm typecheck && pnpm lint && pnpm test`. If it is
   red, stop and report — do not commit a failing tree. If a command cannot run in
   this environment, say so and continue only with the owner's agreement.

2. **Update `docs/PROGRESS.md`**: what is now done, what is next, known issues,
   and any decision made with its rationale. Absolute dates, not relative ones.
   Record assumptions you had to make. Keep the existing table format.

3. **Commit** following `.claude/rules/git.md`. Conventional commit, English, one
   logical change per commit — split the diff if it contains more than one. Every
   commit carries a `Role:` trailer (`$ARGUMENTS`, defaulting to `engineer`), and
   a `Reviewed-by:` trailer when a role verified it:

   ```
   feat(scope): what changed

   Why it changed, and any caveat the owner should know.

   Role: engineer
   Reviewed-by: qa
   Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
   ```

4. **Show the trail** and stop:

   ```
   git log --oneline -5
   git log -1 --format='%(trailers:key=Role,valueonly)'
   ```

**Never `git push`.** The owner reviews `git log` first and pushes themselves.
