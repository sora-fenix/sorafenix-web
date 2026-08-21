-- Row Level Security for every domain table (CLAUDE.md rule 6, docs/SPEC.md §1).
--
-- The rule is uniform and deliberately boring: a row is visible to, and writable
-- by, exactly the authenticated users who hold a membership in its workspace.
-- `is_workspace_member(uuid)` is defined in drizzle/0001_rls.sql as a
-- SECURITY DEFINER function with a pinned search_path, so the policy on
-- `memberships` does not recurse through its own policy.
--
-- Written out per table rather than generated in a DO loop, so that
-- `grep -n companies drizzle/*.sql` shows you the actual policy protecting it.
--
-- Scope reminder: this protects the Supabase-client path (anon key + user JWT).
-- lib/db/drizzle.ts connects as a privileged role and bypasses RLS by design —
-- those queries must filter by workspace_id in application code.

-- ---------------------------------------------------------------------------
-- Foreign keys to Supabase's user table
--
-- Declared here rather than in lib/db/schema/ so drizzle-kit never attempts to
-- manage anything in the `auth` schema. ON DELETE SET NULL, not CASCADE: losing
-- a salesperson must not delete the leads they owned.
-- ---------------------------------------------------------------------------

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_owner_id_auth_users_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_created_by_auth_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_approved_by_auth_users_id_fk"
  FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants backfill for the tables created in 0000
--
-- 0001 enabled RLS on these but left privileges to Supabase's default-privilege
-- rules. Being explicit means the policies work on any Postgres, not only on a
-- database where those defaults happen to be configured.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "workspaces" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "memberships" TO authenticated;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "products" TO authenticated;
--> statement-breakpoint
CREATE POLICY "products_member_all" ON "products"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- knowledge_docs
-- ---------------------------------------------------------------------------

ALTER TABLE "knowledge_docs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_docs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_docs" TO authenticated;
--> statement-breakpoint
CREATE POLICY "knowledge_docs_member_all" ON "knowledge_docs"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- integrations
--
-- credentials_encrypted lives in this table. The policy keeps it inside the
-- workspace; the application must additionally never select that column into a
-- client component.
-- ---------------------------------------------------------------------------

ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "integrations" TO authenticated;
--> statement-breakpoint
CREATE POLICY "integrations_member_all" ON "integrations"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "campaigns" TO authenticated;
--> statement-breakpoint
CREATE POLICY "campaigns_member_all" ON "campaigns"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------

ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "companies" TO authenticated;
--> statement-breakpoint
CREATE POLICY "companies_member_all" ON "companies"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- contacts
--
-- Personal data under UU PDP 27/2022. Workspace isolation here is a legal
-- obligation, not only a product requirement.
-- ---------------------------------------------------------------------------

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "contacts" TO authenticated;
--> statement-breakpoint
CREATE POLICY "contacts_member_all" ON "contacts"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leads" TO authenticated;
--> statement-breakpoint
CREATE POLICY "leads_member_all" ON "leads"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- activities
--
-- Append-only in spirit (CLAUDE.md rule 10). The policy allows UPDATE/DELETE so
-- a workspace can exercise its deletion rights; nothing in the app issues them.
-- ---------------------------------------------------------------------------

ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "activities" TO authenticated;
--> statement-breakpoint
CREATE POLICY "activities_member_all" ON "activities"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "messages" TO authenticated;
--> statement-breakpoint
CREATE POLICY "messages_member_all" ON "messages"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- sequence_runs
-- ---------------------------------------------------------------------------

ALTER TABLE "sequence_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sequence_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sequence_runs" TO authenticated;
--> statement-breakpoint
CREATE POLICY "sequence_runs_member_all" ON "sequence_runs"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- suppressions
-- ---------------------------------------------------------------------------

ALTER TABLE "suppressions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suppressions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "suppressions" TO authenticated;
--> statement-breakpoint
CREATE POLICY "suppressions_member_all" ON "suppressions"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- webhook_events
--
-- Written by service-role handlers, which bypass RLS. The policy exists so a
-- workspace can inspect its own delivery history and so the table is not an
-- unguarded hole if it is ever exposed through PostgREST.
-- ---------------------------------------------------------------------------

ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_events" TO authenticated;
--> statement-breakpoint
CREATE POLICY "webhook_events_member_all" ON "webhook_events"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_runs
-- ---------------------------------------------------------------------------

ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_runs" TO authenticated;
--> statement-breakpoint
CREATE POLICY "ai_runs_member_all" ON "ai_runs"
  FOR ALL TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"))
  WITH CHECK ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Sequence usage for the authenticated role.
--
-- No sequences today (every primary key is gen_random_uuid()), but new tables
-- created later inherit these defaults instead of silently failing on INSERT.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA "public" TO authenticated;
