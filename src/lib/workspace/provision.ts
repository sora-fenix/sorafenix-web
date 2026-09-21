import 'server-only'

import { db, schema } from '@/lib/db/drizzle'
import { type Result, err, ok } from '@/lib/types/result'
import type { Workspace } from '@/lib/db/schema'

import { slugCandidate, slugifyWorkspaceName } from './slug'

/**
 * Creates a workspace and makes its creator the owner.
 *
 * This is the one write the browser genuinely cannot make. `drizzle/0001_rls.sql`
 * gives `workspaces` no INSERT policy at all, and `memberships_insert_owner_or_manager`
 * requires the caller to already hold owner or manager in the target workspace —
 * so the creator's own first membership row is unreachable through the RLS path
 * by construction, not by oversight. It has to happen server-side.
 *
 * Runs against the Drizzle handle, which bypasses RLS. The rule that every query
 * filters by `workspace_id` (CLAUDE.md rule 6) is satisfied here by the workspace
 * being created in the same transaction: the membership names the id the insert
 * just returned, and reads nothing it did not write.
 */

/** How many suffixed slugs to try before giving up. */
const MAX_SLUG_ATTEMPTS = 25

export type ProvisionError = 'invalid_name' | 'slug_exhausted' | 'db_error'

export type ProvisionInput = {
  userId: string
  name: string
}

export async function provisionWorkspace(
  input: ProvisionInput,
): Promise<Result<Workspace, ProvisionError>> {
  const name = input.name.trim()
  if (name === '') return err('invalid_name')

  const base = slugifyWorkspaceName(name)

  try {
    return await db.transaction(async (tx) => {
      // Insert-and-catch rather than select-then-insert. Between a uniqueness
      // check and the write, a concurrent signup can take the slug; the unique
      // index `workspaces_slug_key` is the only thing that actually decides, so
      // let it decide and step to the next candidate when it says no.
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
        const created = await tx
          .insert(schema.workspaces)
          .values({ name, slug: slugCandidate(base, attempt) })
          .onConflictDoNothing({ target: schema.workspaces.slug })
          .returning()

        const workspace = created[0]
        if (workspace === undefined) continue

        // Same transaction: a workspace with no owner would be unreachable
        // forever, and no row at all is a better outcome than that.
        await tx.insert(schema.memberships).values({
          workspaceId: workspace.id,
          userId: input.userId,
          role: 'owner',
        })

        return ok(workspace)
      }

      return err<ProvisionError>('slug_exhausted')
    })
  } catch (cause) {
    // A failed membership insert rolls the workspace back with it. Most likely
    // cause is the FK to auth.users — a user id that no longer exists.
    console.error('provisionWorkspace failed', cause)
    return err('db_error')
  }
}
