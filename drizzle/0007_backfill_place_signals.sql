-- Backfill companies.rating / companies.review_count from companies.raw.
--
-- Hand-written: drizzle-kit generates the columns, it does not move data into
-- them. Every company scraped before 0006 carries these two facts inside the
-- untouched Serper payload, under the Indonesian sheet headers the n8n workflow
-- emits ("Rating", "Jumlah Review"). Reading them there is fine once, on the way
-- out; src/lib/scoring/signals.ts reads the columns.
--
-- Idempotent twice over, so a re-run is a no-op rather than a second write:
--   * `where rating is null` skips a row already backfilled, and never
--     overwrites a value a later ingest or a human put there;
--   * the `~` guards reject '' and any non-numeric text, so a malformed payload
--     is left null (= "unknown") instead of failing the migration. `raw->>` on a
--     missing key yields NULL, which the regex operator also rejects.
--
-- 5.0 is the ceiling Google publishes; anything above it is corrupt and stays
-- null rather than becoming the highest-scoring lead in the workspace.

update companies
set rating = (raw->>'Rating')::numeric(2, 1)
where rating is null
  and raw->>'Rating' ~ '^[0-9]+(\.[0-9]+)?$'
  and (raw->>'Rating')::numeric > 0
  and (raw->>'Rating')::numeric <= 5;
--> statement-breakpoint
update companies
set review_count = (raw->>'Jumlah Review')::integer
where review_count is null
  and raw->>'Jumlah Review' ~ '^[0-9]{1,9}$';
