-- One WAHA session belongs to exactly one workspace.
--
-- The WhatsApp transport resolves the tenant for every inbound event from the
-- session name in the payload (`lib/outreach/whatsapp.ts` →
-- `resolveSessionWorkspace`). The session is the tenant key precisely because the
-- sender's phone number cannot be: one number may legitimately appear in two
-- workspaces' `contacts`, so a number can never choose between them.
--
-- That makes the session's uniqueness a security property, not a convenience.
-- If two workspaces registered the session `default`, every reply arriving on it
-- would be attributable to either of them — one tenant reading another tenant's
-- conversations, which is the exact failure CLAUDE.md rule 6 exists to prevent.
-- The resolver refuses to guess when it finds more than one match, and this index
-- is what makes that branch unreachable in the first place: the SECOND workspace
-- to claim a session fails at `connect-whatsapp.ts`, loudly, at setup time,
-- instead of silently at 02:00 when a customer replies.
--
-- HAND-WRITTEN, because drizzle-kit cannot express it. The uniqueness is over a
-- jsonb expression (`meta->>'session'`) with a partial predicate, and it is
-- deliberately NOT scoped by `workspace_id` — scoping it per workspace would make
-- it tautological, since `integrations_workspace_provider_key` already allows only
-- one whatsapp row per workspace. Cross-workspace is the whole point.
--
-- The predicate leaves everything else alone: gmail and serper rows have their own
-- `meta` shapes and none of them carries a `session`, and a whatsapp row that has
-- not been connected yet has `meta` null. Both are excluded, so any number of them
-- may coexist.
--
-- No RLS change. `integrations` already has its policy from 0003_rls_domain.sql;
-- an index adds no new surface.
--
-- NOT UNIQUE ON `status`. A disconnected workspace still holds its session name,
-- and it must keep holding it: releasing the name on disconnect would let a second
-- workspace grab it and start receiving the first one's traffic the moment the
-- first reconnects.

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_whatsapp_session_key"
  ON "public"."integrations" (("meta"->>'session'))
  WHERE "provider" = 'whatsapp' AND "meta"->>'session' IS NOT NULL;
