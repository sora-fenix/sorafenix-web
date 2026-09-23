-- A workspace must always have at least one owner.
--
-- Found during the 2026-09-20 membership audit and left open at the time. An
-- owner could delete their own `memberships` row and leave a workspace nobody
-- can administer: `workspace:manage`, `member:invite`, `member:manage` and the
-- UU PDP hard-delete all require the owner role, so a workspace with zero owners
-- is unreachable forever. Nothing could grant the role back, because granting it
-- is itself owner-only.
--
-- WHY A TRIGGER AND NOT A POLICY. Two reasons, and the second is the one that
-- decides it.
--
-- 1. The same orphaning has two doors. DELETE is the obvious one; the other is
--    `update memberships set role = 'viewer'` on your own row, because
--    `memberships_update_owner` checks the ACTOR's role and never the target
--    row's new value. A DELETE policy closes one door. Expressing "the row after
--    this update must leave an owner behind" in a policy needs the new row and a
--    count in the same predicate, which WITH CHECK cannot see coherently.
-- 2. **RLS does not run on the path most likely to do this.** `.claude/rules/data.md`
--    is explicit: `src/lib/db/drizzle.ts` connects with `DATABASE_URL`, a
--    privileged role that bypasses RLS entirely, and that is the handle every
--    server-side write in `lib/` uses. A policy would protect the browser and
--    leave the application itself free to orphan a workspace by accident.
--
-- "At least one owner" is an integrity rule about the data, not an authorisation
-- rule about the caller, so it belongs at the layer that cannot be bypassed.
-- A trigger fires for the Drizzle handle, the service role and PostgREST alike.
--
-- Deliberately NOT deferred. An ownership handover should add the new owner
-- before removing the old one, which is the safe order anyway; a deferred
-- constraint would permit the reverse and only complain at COMMIT, by which
-- point the failure is further from its cause.

CREATE OR REPLACE FUNCTION "public"."assert_workspace_keeps_an_owner"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Deleting a workspace cascades to its memberships. The last owner's row
  -- disappearing is correct then, and raising here would make a workspace
  -- undeletable. The parent row is already gone by the time this AFTER trigger
  -- runs, so its absence is the signal.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id
  ) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.workspace_id = OLD.workspace_id
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION
      'workspace % would be left with no owner', OLD.workspace_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- AFTER, so the check sees the table as the statement leaves it rather than
-- having to reason about what is about to change. FOR EACH ROW with the WHEN
-- guard means a bulk delete of ten sales rows costs nothing: only a row that was
-- an owner can reduce the owner count.
CREATE TRIGGER "memberships_keep_an_owner"
AFTER DELETE OR UPDATE ON "memberships"
FOR EACH ROW
WHEN (OLD."role" = 'owner')
EXECUTE FUNCTION "public"."assert_workspace_keeps_an_owner"();
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "public"."assert_workspace_keeps_an_owner"() FROM public;
