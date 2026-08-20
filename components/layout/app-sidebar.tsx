'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { NAV_ITEMS, workspaceHref } from '@/components/layout/nav-items'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

type AppSidebarProps = {
  workspaceSlug: string
  workspaceName: string
}

export function AppSidebar({ workspaceSlug, workspaceName }: AppSidebarProps) {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href={workspaceHref(workspaceSlug, 'dashboard')}>
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg text-sm font-semibold">
                  S
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">SORA</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {workspaceName}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const href = workspaceHref(workspaceSlug, item.segment)
                const isActive = pathname === href || pathname.startsWith(`${href}/`)

                return (
                  <SidebarMenuItem key={item.segment}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <Link href={href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <p className="text-muted-foreground px-2 py-1 text-xs group-data-[collapsible=icon]:hidden">
          Mode otonom nonaktif. Semua pesan butuh persetujuan.
        </p>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
