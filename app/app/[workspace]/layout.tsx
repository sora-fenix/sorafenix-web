import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { AppSidebar } from '@/components/layout/app-sidebar'
import { Topbar } from '@/components/layout/topbar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { getWorkspaceContext, listWorkspacesForUser } from '@/lib/auth/session'

type WorkspaceLayoutProps = {
  children: ReactNode
  params: Promise<{ workspace: string }>
}

export default async function WorkspaceLayout({
  children,
  params,
}: WorkspaceLayoutProps) {
  const { workspace: slug } = await params

  // The middleware has already established that someone is signed in. This is
  // the check that they are a member of *this* workspace (CLAUDE.md rule 6).
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const workspaces = await listWorkspacesForUser(context.user.id)
  const current = {
    id: context.workspace.id,
    name: context.workspace.name,
    slug: context.workspace.slug,
    role: context.role,
  }

  return (
    <SidebarProvider>
      <AppSidebar workspaceSlug={current.slug} workspaceName={current.name} />
      <SidebarInset>
        <Topbar
          current={current}
          workspaces={workspaces}
          userEmail={context.user.email}
          role={context.role}
        />
        <main className="flex-1">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
