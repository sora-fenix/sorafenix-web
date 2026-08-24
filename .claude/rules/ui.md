# Rule: UI

Read before touching `src/app/**` or `src/components/**`.

## Language

UI copy, emails to users, and error messages shown to users are in **Bahasa
Indonesia**. Code, identifiers, comments, commit messages and docs are in
**English**. This split is absolute — an Indonesian identifier or an English
button label are both wrong.

Write copy a salesperson would say, not a translation of English UI jargon.

## Server components by default

RSC unless the component genuinely needs interactivity. `'use client'` is a
decision you justify, not a reflex. Data fetching happens in the server component
via `src/lib/db/queries/**`; client components receive plain props.

## Every screen ships four states

1. **loading** — a skeleton matching the real layout, not a spinner
2. **empty** — explains what will appear here and how to get the first one
3. **error** — what failed and what the user can do, in Bahasa Indonesia
4. **populated**

Reuse `EmptyState` and `PageShell` from `@/components/layout/page-shell`, and the
status badges in `@/components/crm/labels`, rather than writing new ones.

## Mobile

Every screen works on a phone. Tables that cannot shrink scroll horizontally
inside their own container — the page body never scrolls sideways.

## shadcn

`src/components/ui/**` is generated vendor code. Add a component with the shadcn
CLI; do not hand-edit what it wrote and do not copy a variant into it. Project
components go in `src/components/layout/` or `src/components/crm/`.

## Type discipline in JSX too

No `any`, no non-null `!`, no unchecked `as` — eslint enforces all three. If a
route href cannot be typed without a cast, build it through the helpers in
`@/components/layout/nav-items` instead of casting.
