import { redirect } from 'next/navigation'

import { CreateWorkspaceForm } from './create-workspace-form'
import { workspaceHref } from '@/components/layout/nav-items'
import { getCurrentUser, listWorkspacesForUser } from '@/lib/auth/session'

/**
 * Entry point for /app. Sends the user to their first workspace, or — when they
 * have none — lets them create one. The middleware guarantees someone is signed
 * in by the time this runs.
 *
 * The form lives on this route rather than a literal `/app/new`, which would
 * shadow the `[workspace]` segment for any workspace slugged `new`.
 */
export default async function AppIndexPage() {
  const user = await getCurrentUser()
  if (user === null) redirect('/login?next=/app')

  const workspaces = await listWorkspacesForUser(user.id)
  const first = workspaces[0]

  if (first === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col px-4 py-24">
        <h1 className="text-lg font-semibold">Buat workspace pertama Anda</h1>
        <p className="text-muted-foreground mt-1.5 mb-6 text-sm">
          Workspace adalah ruang kerja tim Anda — semua lead, kampanye dan percakapan
          tersimpan di dalamnya. Anda masuk sebagai <strong>{user.email}</strong>.
        </p>

        <CreateWorkspaceForm />
      </div>
    )
  }

  redirect(workspaceHref(first.slug, 'dashboard'))
}
