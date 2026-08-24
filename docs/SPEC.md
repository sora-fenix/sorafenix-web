# SORA — MVP Spec

> This is the build contract. The original PRD lists 34 sections and 11 modules.
> **MVP is 6 of them.** Anything not in this file is Phase 2+ and must not be built yet.

---

## 0. MVP scope

**In:** Lead Hunter ingestion · Contact/company enrichment · AI Qualification · CRM · AI Content Generator + Approval · Email + WhatsApp sending · Follow-up sequence · Reply Reader · Auto status update · Basic dashboard.

**Out (Phase 2+):** Sales Copilot chat, forecasting, drag-drop pipeline board, A/B testing, multi-agent orchestration, LinkedIn, Power BI, calendar booking, deal/revenue tracking, per-salesperson leaderboards.

**Success = a user can:** define a target market → get 100+ deduped leads with scores and reasons → approve 10 AI-drafted emails → they send → replies get classified and lead status updates automatically → dashboard reflects it. End to end, no manual DB edits.

---

## 1. Data model

Every table below has `id uuid pk`, `workspace_id uuid not null`, `created_at`, `updated_at`, and RLS scoped to workspace membership.

```
workspaces          name, slug, plan, daily_email_limit (default 200),
                    daily_wa_limit (default 100), autonomous_mode (default false), timezone
memberships         user_id, role: owner | manager | sales | viewer
products            name, description, value_prop, icp jsonb   -- ideal customer profile
knowledge_docs      type: company_profile|catalog|pricelist|faq|case_study|script|objection|tnc
                    title, content text, file_url, is_active
campaigns           name, product_id, target jsonb, status: draft|running|paused|done,
                    daily_cap, created_by
companies           name, domain (unique per workspace), website, industry, city, country,
                    size_band, employee_count, description, source, source_url,
                    raw jsonb, dedupe_key
contacts            company_id, name, position, department, email, phone, whatsapp,
                    source, email_status: unknown|valid|invalid|bounced, opt_out_at
leads               campaign_id, company_id, contact_id, score int, category: hot|warm|cold,
                    score_factors jsonb, score_reason text, status (enum below),
                    owner_id, last_activity_at, next_action_at
messages            lead_id, channel: email|whatsapp, direction: out|in,
                    status: draft|needs_input|pending_approval|approved|queued|sent|
                            delivered|opened|replied|bounced|failed|rejected,
                    subject, body, template_id, provider_message_id, thread_id,
                    scheduled_at, sent_at, approved_by, reject_reason, idempotency_key
sequence_runs       lead_id, sequence_id, current_step int, next_run_at,
                    state: active|paused|stopped, stop_reason
activities          lead_id, type, channel, payload jsonb, actor: ai|human|system
suppressions        kind: email|phone|domain, value, reason  -- unique(workspace_id,kind,value)
ai_runs             agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, error
integrations        provider: gmail|whatsapp|serper, credentials_encrypted, status, meta jsonb
webhook_events      provider, idempotency_key unique, payload jsonb, processed_at
```

**Lead status enum (single source of truth):**
`new → qualified → contacted → replied → interested → meeting → proposal → negotiation → won | lost | do_not_contact`

Transitions are only made by `src/lib/crm/status.ts`. Nothing else writes `leads.status`.

---

## 2. Module 1 — Lead ingestion (n8n → SORA)

n8n does the scraping. SORA owns dedupe, storage, and everything after.

**`POST /api/webhooks/n8n/leads`**

Header: `x-sora-signature: sha256=<hmac of raw body using N8N_WEBHOOK_SECRET>`

```json
{
  "campaign_id": "uuid",
  "source": "serper_places" | "serper_search" | "csv",
  "idempotency_key": "run_20260820_143000",
  "items": [{
    "company_name": "Pet Shop Surabaya",
    "website": "https://petshopsby.com",
    "address": "Jl. ...", "city": "Surabaya",
    "phone": "+628123456789", "email": "info@petshopsby.com",
    "category": "Pet store", "source_url": "https://...",
    "raw": {}
  }]
}
```

Response: `{ accepted, inserted, duplicates, rejected: [{index, reason}] }`

**Dedupe** (`src/lib/leads/dedupe.ts`, unit tested) — match in this order, first hit wins:
1. normalised domain (strip `www.`, protocol, path, lowercase)
2. normalised phone (E.164; Indonesian `08xx` / `62xx` / `+62xx` all collapse to `+62xx`)
3. normalised email
4. fuzzy company name + city (trigram ≥ 0.85)

On duplicate: don't insert, merge any newly-found non-null fields into the existing row, log an activity.

**Reject** rows with no website AND no phone AND no email. They are not leads.

Also accept CSV/XLSX upload through the UI hitting the same pipeline.

---

## 3. Module 2 — Enrichment

Job `enrich_company`. For a company with a website:
1. Fetch homepage + try `/contact`, `/kontak`, `/about`, `/hubungi-kami` (max 4 requests, 10s timeout each, respect `robots.txt`, one concurrent request per domain).
2. Extract emails and Indonesian phone numbers. Strip HTML to text before regex or you will match tracking-pixel garbage. Filter noise domains: `sentry.io`, `wixpress`, `godaddy`, `example.com`, `*.png/jpg/js/css`.
3. LLM summary → `companies.description` (≤ 60 words) + `industry` + `size_band`, **strictly from fetched text**, plus a `confidence` field. Low confidence → leave field null.
4. Any fetch failure is a logged warning, never a job failure. Partial data is fine.

---

## 4. Module 3 — AI Qualification

`src/lib/scoring/rubric.ts` — deterministic weights from the PRD:

| Factor | Weight |
|---|---|
| Industry fit | 25 |
| Product need | 25 |
| Company size | 15 |
| Decision-maker availability | 15 |
| Location | 10 |
| Digital / business signals | 10 |

Flow: LLM returns **only per-factor sub-scores 0–100 + one-sentence evidence each** (Zod-validated). Code computes the weighted total. The model never returns the final number — that keeps scores comparable and debuggable.

`80–100 hot` · `50–79 warm` · `0–49 cold`

Store `score`, `category`, `score_factors` (each factor: score, weight, evidence), `score_reason` (2–3 sentences, Bahasa Indonesia).

Any factor whose evidence is not grounded in stored data must score 50 (neutral), not be guessed upward.

---

## 5. Module 5 — AI Content Generator

Input: company + contact + product + relevant `knowledge_docs` + lead score + previous messages in thread.

Output (Zod): `{ subject, body, cta, personalization_used: string[], missing_info: string[], confidence: number }`

- If `missing_info` is non-empty → message status `needs_input`, surfaced in the approval queue with the gaps highlighted. Do not send.
- Settings per campaign: language (ID/EN), tone (formal/casual/professional), length (short/medium/long).
- Hard constraint in the system prompt: no prices, no discounts, no specs, no claims that aren't verbatim-supported by `knowledge_docs`. Every personalization claim must map to a stored field, listed in `personalization_used`.

WhatsApp drafts must fit an approved Cloud API template; variables only.

---

## 6. Modules 6/7 — Sending

Single entry point: `sendMessage({ messageId, idempotencyKey })` → calls `send-guard` → provider adapter → writes `messages.status` + activity.

**Email (Gmail API):** per-workspace OAuth, threading via `thread_id`, open tracking pixel, click tracking on wrapped links, `List-Unsubscribe` + `List-Unsubscribe-Post` headers, bounce → suppress address.

**WhatsApp (Cloud API):** template messages only for first contact, session messages within the 24h window, status callbacks (sent/delivered/read/failed), inbound webhook → `messages` row direction `in`.

Rate limits enforced by workspace: `daily_email_limit`, `daily_wa_limit`, plus max 1 message per contact per 24h across all channels.

---

## 7. Module 8 — Follow-up sequences

Default sequence (editable per campaign):

| Step | Day | Channel |
|---|---|---|
| 1 | 0 | Email |
| 2 | 3 | WhatsApp |
| 3 | 7 | Email |
| 4 | 14 | Task: call recommendation (human) |
| 5 | 30 | Close or move to nurture |

`src/lib/sequences/state-machine.ts` is a pure function `(run, event) → nextRun` — fully unit tested, no I/O.

**Hard stop conditions:** contact replied · opted out · meeting booked · status ≥ `interested` · email bounced · WhatsApp number invalid · campaign paused.
Stopping writes `stop_reason`. A stopped run never resumes automatically.

Runner ticks every 5 minutes via `/api/cron/sequences`, claims due rows with `FOR UPDATE SKIP LOCKED`.

---

## 8. Modules 9/10 — Reply Reader + auto status

Classify every inbound message into exactly one label:

`INTERESTED · CONSIDERING · NOT_INTERESTED · ASKING_INFORMATION · ASKING_PRICE · REQUEST_PROPOSAL · REQUEST_MEETING · NEGOTIATION · COMPLAINT · FOLLOW_UP_LATER · OUT_OF_OFFICE · WRONG_CONTACT · UNSUBSCRIBE`

Output: `{ label, confidence, entities: { date?, budget?, product? }, suggested_status, suggested_reply, escalate: boolean }`

**Escalate to a human (never auto-reply) when:** price negotiation · complaint · contract request · info absent from knowledge base · explicit buying intent · `confidence < 0.8`.

`UNSUBSCRIBE` or any Indonesian opt-out phrasing ("jangan hubungi lagi", "stop", "tidak berminat") → write `suppressions` + status `do_not_contact` + stop all runs, **immediately and without approval**. This is the one action AI takes autonomously, because it's the safe direction.

Suggested replies always land in the approval queue.

---

## 9. Module 11 — Dashboard

Cards: Total Leads · Qualified · Hot · Emails Sent · WA Sent · Replies · Meetings · Reply Rate · Conversion Rate.
Funnel: New → Qualified → Contacted → Replied → Meeting → Proposal → Won.
Today's queue: leads needing follow-up, drafts awaiting approval, escalations.
All figures come from SQL views, computed server-side, filterable by campaign and date range. No client-side aggregation.

---

## 10. Acceptance criteria

**Ingestion** — Given the same n8n payload posted twice, when both complete, then the second inserts 0 rows and returns `duplicates` equal to the item count.

**Dedupe** — Given `0812-3456-7890`, `+62 812 3456 7890`, and `62812-34567890` in one batch, then exactly one contact exists.

**Qualification** — Given a company with a complete profile, when scoring runs, then score, category, per-factor breakdown, and a Bahasa Indonesia reason are stored; re-running on unchanged data changes the score by ≤ 3 points.

**Content** — Given a lead whose product price is not in the knowledge base, when the AI drafts an email mentioning price, then the draft is `needs_input` and lists the gap. It is not sendable.

**Send guard** — Given a contact on the suppression list, when a send is attempted by any path, then it returns rejected, writes an activity, and no provider call is made.

**Follow-up** — Given an email sent on day 0 and a reply on day 2, when the day-3 tick runs, then the run is `stopped` with `stop_reason = 'replied'` and no WhatsApp is sent.

**Reply reader** — Given "Menarik, boleh dikirimkan proposal dan pricelist?", then label `REQUEST_PROPOSAL`, status → `interested`, escalate `true` (price requested), and a suggested reply sits in the approval queue.

---

## 11. Success metrics (MVP targets)

Enrichment success > 80% · Dedupe accuracy > 95% · Scoring generated > 95% · Email delivery > 95% · Activity logging > 95% · Sequence execution > 95% · Reply classification accuracy > 85% · Approval workflow enforced 100%.
