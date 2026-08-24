# Rule: outreach and compliance

Read before touching `src/lib/outreach/**`, `src/lib/sequences/**`, or anything
that sends a message.

## The send guard

Every outbound message passes `src/lib/outreach/send-guard.ts`. It checks, **in
this order**:

1. suppression / opt-out list
2. workspace daily sending limit
3. per-contact cooldown
4. duplicate campaign send
5. approval status
6. quiet hours, in the **lead's** local time — not the workspace's

Any failure returns a typed rejection. It never throws, and it never sends.
**There is no bypass path.** If a caller needs to skip a check, the answer is no.

`suppressions` is checked before *every* send, not once at campaign build time.

## Channel rules

**WhatsApp.** Template messages only outside the 24-hour customer service window.
Honour opt-in. A reply of "STOP" / "jangan hubungi" writes to `suppressions`
immediately and stops every sequence for that contact — not just the current one.

**Email.** Every outbound carries `List-Unsubscribe` headers and a working
unsubscribe link. A bounce suppresses the address.

## Who we are allowed to contact

Business contacts only: company email, office or business number. Never store or
message a personal number scraped from a profile page without a lawful basis.
If the source of a contact is unclear, treat it as personal and do not send.

## Idempotency

Every webhook handler and every send operation takes an `idempotency_key` and is
safe to replay. Handled keys are stored in `webhook_events`. Assume every webhook
will be delivered twice, because it will be.

## Data deletion

A workspace owner can export and hard-delete all contact data. This is a UU PDP
27/2022 obligation, not a nice-to-have — build it into any table that stores
contact data from day one.

## Audit

Any change to a lead's status, score, or owner writes an `activities` row with
`actor: 'ai' | 'human' | 'system'`. Lead status transitions are made **only** by
`src/lib/crm/status.ts`; nothing else writes `leads.status`.
