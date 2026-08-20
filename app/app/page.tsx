import { redirect } from 'next/navigation'

import { workspaceHref } from '@/components/layout/nav-items'
import { getCurrentUser, listWorkspacesForUser } from '@/lib/auth/session'

/**
 * Entry point for /app. Sends the user to their first workspace. The middleware
 * guarantees someone is signed in by the time this runs.
 */
export default async function AppIndexPage() {
  const user = await getCurrentUser()
  if (user === null) redirect('/login?next=/app')

  const workspaces = await listWorkspacesForUser(user.id)
  const first = workspaces[0]

  if (first === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-24 text-center">
        <h1 className="text-lg font-semibold">Anda belum punya workspace</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Minta pemilik workspace untuk mengundang <strong>{user.email}</strong>, atau
          jalankan <code className="font-mono text-xs">pnpm db:seed</code> untuk membuat
          workspace demo.
        </p>
      </div>
    )
  }

  redirect(workspaceHref(first.slug, 'dashboard'))
}
