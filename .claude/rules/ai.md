# Rule: LLM calls

Read before touching `src/lib/ai/**` or writing anything that calls a model.

## Single entry point

Every LLM call goes through `src/lib/ai/agent.ts`. No `fetch` to a model provider
anywhere else in the codebase — not in a route handler, not in a script.

`agent.ts` owns: typed Zod input and output, retry with backoff, a timeout, and a
row written to `ai_runs` (agent, model, tokens, cost, latency, ok/error). If you
need a new behaviour, extend `agent.ts`; do not route around it.

Model IDs live in `src/lib/ai/models.ts` and nowhere else. Primary
`gemini-2.5-flash`, fallback `gpt-4.1-mini`. Changing a model ID is a stack change
— ask the owner first.

## The AI must never invent facts

Company details, prices, features, discounts, specs, delivery times — these come
**only** from the database or `knowledge_docs`. Never from the model's own
knowledge, never inferred from a similar company, never "a reasonable default".

When a fact is missing: leave the placeholder empty and flag the draft
`needs_input`. An empty slot a human fills is a working product. A plausible
invented price is a lie sent to a customer under our name.

## Output handling

- Parse every model response with a Zod schema from `src/lib/ai/schemas/`. An
  unparseable response is an error path, not a cast.
- The model returns per-factor sub-scores only; the final score is computed in
  code (`src/lib/scoring/rubric.ts`) so it is deterministic and testable.
- Prompts live in `src/lib/ai/prompts/` as files, not inline string literals, so
  a prompt change shows up as a reviewable diff.

## Human-in-the-loop

AI proposes → human approves → system executes. `workspace.autonomous_mode` exists
in the schema but ships `false` and is **not** wired to skip approval in the MVP.
Do not wire it.
