-- Row Level Security for the foundation tables (CLAUDE.md rule 6).
--
-- Hand-written because drizzle-kit does not emit RLS policies, and because the
-- foreign key to auth.users cannot live in lib/db/schema.ts without drizzle-kit
-- trying to manage Supabase's own `auth` schema.
--
-- Scope: this protects the Supabase-client path (anon key + user JWT). Queries
-- made through lib/db/drizzle.ts connect as a privileged role and bypass RLS by
-- design, so they must filter by workspace_id in application code.

-- ---------------------------------------------------------------------------
-- Foreign key to Supabase's user table
-- ---------------------------------------------------------------------------

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_user_id_auth_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Membership helper
--
-- SECURITY DEFINER so the policy on `memberships` can read `memberships`
-- without recursing through its own RLS policy. search_path is pinned to defend
-- against search_path hijacking, which is the standard footgun with definer
-- functions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."is_workspace_member"("target_workspace_id" uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.workspace_id = target_workspace_id
      AND m.user_id = auth.uid()
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."has_workspace_role"(
  "target_workspace_id" uuid,
  "allowed_roles" "public"."membership_role"[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.workspace_id = target_workspace_id
      AND m.user_id = auth.uid()
      AND m.role = ANY(allowed_roles)
  );
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "public"."is_workspace_member"(uuid) FROM public;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."has_workspace_role"(uuid, "public"."membership_role"[]) FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."is_workspace_member"(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."has_workspace_role"(uuid, "public"."membership_role"[]) TO authenticated;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "workspaces_select_member" ON "workspaces"
  FOR SELECT TO authenticated
  USING ("public"."is_workspace_member"("id"));
--> statement-breakpoint

CREATE POLICY "workspaces_update_owner" ON "workspaces"
  FOR UPDATE TO authenticated
  USING ("public"."has_workspace_role"("id", ARRAY['owner']::"public"."membership_role"[]))
  WITH CHECK ("public"."has_workspace_role"("id", ARRAY['owner']::"public"."membership_role"[]));
--> statement-breakpoint

CREATE POLICY "workspaces_delete_owner" ON "workspaces"
  FOR DELETE TO authenticated
  USING ("public"."has_workspace_role"("id", ARRAY['owner']::"public"."membership_role"[]));
--> statement-breakpoint

-- No INSERT policy: workspaces are provisioned server-side through
-- lib/db/admin.ts, never created directly by a browser client.

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "memberships_select_member" ON "memberships"
  FOR SELECT TO authenticated
  USING ("public"."is_workspace_member"("workspace_id"));
--> statement-breakpoint

CREATE POLICY "memberships_insert_admin" ON "memberships"
  FOR INSERT TO authenticated
  WITH CHECK (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner', 'manager']::"public"."membership_role"[]
    )
  );
--> statement-breakpoint

CREATE POLICY "memberships_update_admin" ON "memberships"
  FOR UPDATE TO authenticated
  USING (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner', 'manager']::"public"."membership_role"[]
    )
  )
  WITH CHECK (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner', 'manager']::"public"."membership_role"[]
    )
  );
--> statement-breakpoint

CREATE POLICY "memberships_delete_admin" ON "memberships"
  FOR DELETE TO authenticated
  USING (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner', 'manager']::"public"."membership_role"[]
    )
  );
