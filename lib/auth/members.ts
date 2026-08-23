import 'server-only'

import { createSupabaseAdminClient } from '@/lib/db/admin'
import { listMembers, type MemberRow } from '@/lib/db/queries/records'

/**
 * Workspace members with their sign-in email attached.
 *
 * `memberships` deliberately stores only `user_id` — identity lives in
 * Supabase Auth's `auth.users`, which we do not own and do not model in
 * lib/db/schema. So the two have to be joined in application code.
 *
 * CLAUDE.md rule 6 allows this: `lib/db/admin.ts` is `server-only`, and the
 * one caller renders under app/app/[workspace]/layout.tsx, which has already
 * verified the viewer is a member of this workspace.
 */

export type MemberWithEmail = MemberRow & { email: string | null }

/**
 * Best-effort email resolution. If the Auth admin call fails, every member
 * comes back with `email: null` rather than throwing — an unreachable auth
 * service should degrade the members list, not blank the settings screen.
 */
export async function listMembersWithEmail(
  workspaceId: string,
): Promise<MemberWithEmail[]> {
  const members = await listMembers(workspaceId)
  if (members.length === 0) return []

  const emails = await fetchEmailsById()

  return members.map((member) => ({
    ...member,
    email: emails.get(member.userId) ?? null,
  }))
}

async function fetchEmailsById(): Promise<Map<string, string>> {
  const byId = new Map<string, string>()

  try {
    const admin = createSupabaseAdminClient()
    // Same un-paginated call as scripts/seed.ts. Fine while a workspace has a
    // handful of members; revisit with the invite flow (docs/PROGRESS.md
    // known issue 4).
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 })
    if (error !== null) return byId

    for (const user of data.users) {
      if (user.email !== undefined) byId.set(user.id, user.email)
    }
  } catch {
    return byId
  }

  return byId
}
