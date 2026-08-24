---
description: Run one vertical slice through pm, architect, engineer, qa and reviewer
argument-hint: <feature description>
---

Deliver **one** vertical slice for: $ARGUMENTS

Run the roles in order, stopping at each gate. Each role runs as its own subagent
so its working context does not accumulate in this conversation — that is the
point of the pipeline.

1. **pm** — scope it. Output: the slice, in scope, out of scope, acceptance
   criteria, definition of done, at most three open questions.
   **Gate:** show the scope to the owner. If there are open questions, ask them
   with AskUserQuestion before continuing.

2. **architect** — design it, but only if the slice touches the schema or crosses
   module boundaries. For a change contained in one module, skip this and say why.
   **Gate:** show the data model and module map to the owner for approval before
   any code is written. A schema change is hard to reverse.

3. **engineer** — implement it: schema → migration → server logic → API → UI.
   One slice only.

4. **qa** — write and run the tests, check the definition of done item by item.
   **Gate:** if QA reports FAIL, return to the engineer with the findings. Do not
   proceed to review with a failing gate.

5. **reviewer** — read-only audit of the diff, tenant isolation first.
   **Gate:** report findings to the owner. The reviewer cannot patch; if a finding
   is real, the engineer fixes it and QA re-runs.

Then stop. Do not commit and do not push — run `/handoff` when the owner is
satisfied.

If the request contains more than one slice, the pm decides which one to build
now and the others wait. Do not run this pipeline twice in one invocation.
