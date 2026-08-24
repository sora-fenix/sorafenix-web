import { UserMenu } from '@/components/layout/user-menu'
import { WorkspaceSwitcher } from '@/components/layout/workspace-switcher'
import type { Role } from '@/lib/auth/permissions'
import type { WorkspaceSummary } from '@/lib/auth/session'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

type TopbarProps = {
  current: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
  userEmail: string
  role: Role
}

export function Topbar({ current, workspaces, userEmail, role }: TopbarProps) {
  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 !h-4" />

      <WorkspaceSwitcher current={current} workspaces={workspaces} />

      <div className="ml-auto flex items-center gap-2">
        <UserMenu email={userEmail} role={role} />
      </div>
    </header>
  )
}
