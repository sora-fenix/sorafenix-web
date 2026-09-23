-- Row Level Security for `scrape_cursors` (ADR 0001 §4).
--
-- Hand-written because drizzle-kit emits no policies. `0014` created the table,
-- so without this file it would sit in `public` with Supabase's default ACL and
-- no RLS at all -- readable and writable by any authenticated user in any
-- workspace, which is the exact failure CLAUDE.md rule 6 exists to prevent.
--
-- DELIBERATE DEVIATION from the uniform `_member_all` pattern in
-- `0003_rls_domain.sql`, in the restrictive direction. Every other domain table
-- grants SELECT/INSERT/UPDATE/DELETE to `authenticated` because a person edits
-- the rows. Nobody edits a cursor: it is written by the service-role planner and
-- read by a coverage panel. So a member may SEE where their sweep has got to and
-- may forge nothing -- not a position, not a lap, not a fingerprint. Forging a
-- fingerprint is the interesting one: it would make a campaign re-walk ground it
-- has already paid for, on the shared Serper account.
--
-- Workspace deletion still cascades through `workspace_id`, so the UU PDP
-- 27/2022 hard-delete obligation is met without a DELETE grant.
--
-- WHY THE REVOKE COMES FIRST, and this is the lesson `0011` paid for: grants
-- here are an allowlist, and a broad grant already exists before we say a word.
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
-- TO anon, authenticated, service_role`, verified on this database --
-- `pg_default_acl` shows `arwdDxtm` for all three. So `scrape_cursors` arrived
-- from `0014` with INSERT, UPDATE and DELETE already granted, and a bare
-- `GRANT SELECT` would have added nothing and removed nothing. Postgres sums
-- table-level and column-level privileges; it does not intersect them. The
-- existing grant has to go before the narrow one means anything.
--
-- `anon` is revoked too. It holds no membership so no policy would admit it
-- anyway, but leaving a table-level INSERT grant standing for an unauthenticated
-- role means one forgotten policy is the whole breach. `service_role` keeps its
-- default grant: it is the planner, and it is the only writer.

ALTER TABLE "scrape_cursors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "scrape_cursors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

REVOKE ALL ON "scrape_cursors" FROM "authenticated";
--> statement-breakpoint
REVOKE ALL ON "scrape_cursors" FROM "anon";
--> statement-breakpoint

GRANT SELECT ON "scrape_cursors" TO "authenticated";
--> statement-breakpoint

CREATE POLICY "scrape_cursors_member_read" ON "scrape_cursors"
  FOR SELECT TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"));
