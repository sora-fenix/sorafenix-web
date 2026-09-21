-- Let a manager invite members, without letting one mint an owner.
--
-- Owner decision, 2026-09-21: managers should be able to staff their own team.
-- `0012` had just closed membership writes to the owner alone, so this widens
-- exactly one of the three and leaves the other two shut.
--
-- The widening is deliberately narrower than `member:manage`. That action bundles
-- invite, change role and remove, and it was the change-role half that let a
-- manager promote themselves to owner and demote the real one. So
-- `src/lib/auth/permissions.ts` now splits `member:invite` out as its own action;
-- UPDATE and DELETE stay owner-only and `memberships_update_owner` /
-- `memberships_delete_owner` are untouched.
--
-- A manager may not insert a row at `owner`. Without that clause the fix is
-- cosmetic: a manager could invite a second account as owner and sign in as it,
-- reaching `workspace:manage` and the UU PDP hard-delete by a different door.
-- Inviting another `manager` is allowed -- it is lateral, and a manager who
-- cannot change roles cannot climb from there.
--
-- The matrix in permissions.ts cannot enforce this half: `can()` answers about a
-- role and an action and never sees the role being granted. So the ceiling lives
-- here, in the WITH CHECK, and the matrix answers only "may this person invite
-- at all". Both layers have to agree for a write to land, which is decision 70.
--
-- Consequence the owner accepted: a manager can invite but cannot remove, so an
-- invitation sent to the wrong person needs an owner to undo. Revisit by adding
-- a `member:remove` split if that turns out to bite.
--
-- Not reachable through the app yet — there is no invite flow (known issue 4).
-- This is the database half, landed with the matrix so the two never disagree.

DROP POLICY IF EXISTS "memberships_insert_owner" ON "memberships";
--> statement-breakpoint

CREATE POLICY "memberships_insert_owner_or_manager" ON "memberships"
  FOR INSERT TO authenticated
  WITH CHECK (
    "public"."has_workspace_role"(
      "workspace_id", ARRAY['owner']::"public"."membership_role"[]
    )
    OR (
      "public"."has_workspace_role"(
        "workspace_id", ARRAY['manager']::"public"."membership_role"[]
      )
      AND "role" <> 'owner'
    )
  );
