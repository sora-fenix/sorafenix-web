import 'server-only'

import { and, asc, eq } from 'drizzle-orm'
import { cache } from 'react'

import type { Role } from '@/lib/auth/permissions'
import { db } from '@/lib/db/drizzle'
import { memberships, workspaces } from '@/lib/db/schema'
import { createSupabaseServerClient } from '@/lib/db/server'
import type { Workspace } from '@/lib/db/schema'

export type CurrentUser = {
  id: string
  email: string
}

export type WorkspaceContext = {
  workspace: Workspace
  role: Role
  user: CurrentUser
}

export type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  role: Role
}

/**
 * The signed-in user, or null. Wrapped in React `cache` so multiple server
 * components in one render share a single Supabase round-trip.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.getUser()

  if (error !== null || data.user === null) return null
  // Supabase types email as optional; a magic-link user always has one.
  const email = data.user.email ?? ''

  return { id: data.user.id, email }
})

/** Every workspace the user belongs to, for the switcher. Alphabetical. */
export const listWorkspacesForUser = cache(
  async (userId: string): Promise<WorkspaceSummary[]> => {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(workspaces.name))

    return rows
  },
)

/**
 * Resolves a workspace slug for the current user and confirms membership.
 * Returns null when the user is signed out, the slug does not exist, or the
 * user is not a member — callers must not distinguish between those cases in
 * the UI, so a non-member cannot probe for which slugs exist.
 */
export const getWorkspaceContext = cache(
  async (slug: string): Promise<WorkspaceContext | null> => {
    const user = await getCurrentUser()
    if (user === null) return null

    const rows = await db
      .select({ workspace: workspaces, role: memberships.role })
      .from(workspaces)
      .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
      .where(and(eq(workspaces.slug, slug), eq(memberships.userId, user.id)))
      .limit(1)

    const row = rows[0]
    if (row === undefined) return null

    return { workspace: row.workspace, role: row.role, user }
  },
)
