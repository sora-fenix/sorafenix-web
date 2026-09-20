-- Make the membership write policies agree with the permission matrix.
--
-- `src/lib/auth/permissions.ts` gives `member:manage` (invite, change role,
-- remove) to `owner` alone -- `tests/unit/permissions.test.ts:20` asserts that a
-- manager does not have it. The three write policies from `0001_rls.sql`
-- disagreed: each admitted `ARRAY['owner', 'manager']`.
--
-- While a user goes through our UI the matrix decides and nothing is wrong. A
-- manager talking straight to PostgREST with the anon key and their own session
-- never reaches that matrix, and the policy let them through. Worse, the UPDATE
-- policy constrained only WHO was acting, never WHICH row was touched, so a
-- manager could
--
--   1. set their own membership to `owner`, taking all eight actions including
--      `workspace:manage` and the UU PDP hard-delete, and
--   2. demote the real owner to `viewer`, who has none.
--
-- That is a full workspace takeover by someone hired to run campaigns, not a
-- self-promotion. `sales` and `viewer` were never able to do any of it: the
-- policy already excluded them.
--
-- Aligning the database to the matrix is the whole fix; there is no new rule
-- here. If managers should be allowed to invite members later, that is a
-- deliberate change to `permissions.ts` AND to these policies together -- which
-- is the point of making them say the same thing now.
--
-- The policies are renamed `_admin` -> `_owner` because a policy whose name says
-- "admin" while it means "owner" is exactly the kind of thing the next reader
-- trusts without checking. `memberships_select_member` is untouched: every
-- member may see who else is in the workspace.
--
-- Not addressed here, and not a regression: an owner can still delete their own
-- membership and leave a workspace with nobody in it. That predates this
-- migration and needs a product decision about ownership transfer.
--
-- The privileged path is unaffected. `provisionWorkspace` writes the creator's
-- first membership over the Drizzle handle, which bypasses RLS -- it has to,
-- since that row is unreachable through any policy by construction.

DROP POLICY IF EXISTS "memberships_insert_admin" ON "memberships";
--> statement-breakpoint
DROP POLICY IF EXISTS "memberships_update_admin" ON "memberships";
--> statement-breakpoint
DROP POLICY IF EXISTS "memberships_delete_admin" ON "memberships";
--> statement-breakpoint

CREATE POLICY "memberships_insert_owner" ON "memberships"
  FOR INSERT TO authenticated
  WITH CHECK (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner']::"public"."membership_role"[]
    )
  );
--> statement-breakpoint

CREATE POLICY "memberships_update_owner" ON "memberships"
  FOR UPDATE TO authenticated
  USING (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner']::"public"."membership_role"[]
    )
  )
  WITH CHECK (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner']::"public"."membership_role"[]
    )
  );
--> statement-breakpoint

CREATE POLICY "memberships_delete_owner" ON "memberships"
  FOR DELETE TO authenticated
  USING (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner']::"public"."membership_role"[]
    )
  );
