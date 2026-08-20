'use client'

import { Check, ChevronsUpDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useSelectedLayoutSegment } from 'next/navigation'

import { workspaceHref } from '@/components/layout/nav-items'
import { ROLE_LABELS } from '@/lib/auth/permissions'
import type { WorkspaceSummary } from '@/lib/auth/session'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type WorkspaceSwitcherProps = {
  current: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
}

export function WorkspaceSwitcher({ current, workspaces }: WorkspaceSwitcherProps) {
  const router = useRouter()
  // Keep the user on the same section when they switch workspace.
  const segment = useSelectedLayoutSegment() ?? 'dashboard'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 max-w-[16rem] justify-between gap-2 px-2"
          aria-label="Ganti workspace"
        >
          <span className="truncate font-medium">{current.name}</span>
          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Workspace Anda
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => {
              if (workspace.slug === current.slug) return
              router.push(workspaceHref(workspace.slug, segment))
            }}
            className="gap-2"
          >
            <span className="flex-1 truncate">{workspace.name}</span>
            <span className="text-muted-foreground text-xs">
              {ROLE_LABELS[workspace.role]}
            </span>
            {workspace.slug === current.slug ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
