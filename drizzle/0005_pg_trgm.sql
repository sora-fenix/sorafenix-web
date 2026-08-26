-- Trigram matching for dedupe strategy 4.
--
-- SPEC §2: "fuzzy company name + city (trigram >= 0.85)". That threshold is
-- pg_trgm's similarity() verbatim, so the comparison belongs in Postgres rather
-- than in a JavaScript similarity library — it stays in the same query as the
-- workspace filter instead of pulling candidate rows into Node.
--
-- Hand-written: drizzle-kit does not manage extensions, and the search_path
-- pinning below is the entire reason this file exists.

-- Locally the Supabase CLI leaves pg_trgm uninstalled and it lands in `public`;
-- a hosted Supabase project ships it preinstalled in `extensions`. Setting the
-- path here makes both layouts resolve, both for CREATE EXTENSION and for the
-- gin_trgm_ops operator class below.
SET search_path = public, extensions;
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Why a wrapper rather than calling similarity() at the call site:
-- lib/db/drizzle.ts connects with a search_path that reliably contains neither
-- schema, so an unqualified similarity() would resolve on one deployment and
-- fail on the other — a difference that would only surface in production.
-- Pinning search_path on the function settles resolution once, here.
CREATE OR REPLACE FUNCTION public.sora_name_similarity(a text, b text)
RETURNS real
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_catalog
AS $$ SELECT similarity(a, b) $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.sora_name_similarity(text, text)
  TO authenticated, service_role;
--> statement-breakpoint

-- companies.name_normalized is written by lib/leads/normalize.ts, so the index
-- and the application compare the same shape of string.
CREATE INDEX IF NOT EXISTS "companies_name_normalized_trgm_idx"
  ON "companies" USING gin ("name_normalized" gin_trgm_ops);
