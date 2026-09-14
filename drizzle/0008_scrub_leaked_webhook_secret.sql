-- Remove the leaked N8N_WEBHOOK_SECRET from stored payloads.
--
-- `SORA Config` in the n8n lead hunter is a Set node with includeOtherFields, so
-- it stamped its own assignments -- including the live HMAC secret -- onto every
-- item passing through it. `Build SORA Payload` then copied the whole item into
-- each lead's `raw`, and the signed request carrying those items was stored
-- verbatim in `webhook_events.payload` for idempotency.
--
-- Measured before this ran: 1208 of 1208 companies in data-riil and 669 of 855
-- webhook_events, one distinct secret value, still valid at the time.
--
-- This migration is HALF the fix. Deleting the value from the database does not
-- un-leak it -- it has been readable to anything with database access, and to
-- anyone who has read a backup, for the whole scraping week. The secret must be
-- rotated; see docs/PROGRESS.md, known issue 15. The node is fixed in the same
-- commit so new rows never carry it again.
--
-- `-` on jsonb removes a key and is a no-op when the key is absent, so this is
-- idempotent and safe to re-run. The `?` guards keep it from rewriting every row
-- in the table on a second pass.

update companies
set raw = raw - 'webhook_secret'
where raw ? 'webhook_secret';
--> statement-breakpoint
-- webhook_events.payload holds the whole signed request: { campaign_id, source,
-- idempotency_key, items: [...] }. The secret sits inside each item's `raw`, so
-- the key has to be stripped one level down, inside the array, and the array
-- rebuilt. jsonb_agg over an empty set returns NULL, hence the coalesce -- a
-- replayed webhook with no items must not have its payload nulled out.
update webhook_events
set payload = jsonb_set(
  payload,
  '{items}',
  coalesce(
    (
      select jsonb_agg(
        case
          when item->'raw' ? 'webhook_secret'
            then jsonb_set(item, '{raw}', (item->'raw') - 'webhook_secret')
          else item
        end
        order by ordinality
      )
      from jsonb_array_elements(payload->'items') with ordinality as t(item, ordinality)
    ),
    '[]'::jsonb
  )
)
where jsonb_typeof(payload->'items') = 'array'
  and payload::text like '%webhook_secret%';
