'use client'

import { LogOut } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { ROLE_LABELS, type Role } from '@/lib/auth/permissions'
import { createSupabaseBrowserClient } from '@/lib/db/browser'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type UserMenuProps = {
  email: string
  role: Role
}

function initialsFrom(email: string): string {
  const local = email.split('@')[0] ?? ''
  const letters = local.replace(/[^a-zA-Z]/g, '')
  return (letters.slice(0, 2) || '??').toUpperCase()
}

export function UserMenu({ email, role }: UserMenuProps) {
  const router = useRouter()
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function handleSignOut() {
    setIsSigningOut(true)
    const supabase = createSupabaseBrowserClient()
    const { error } = await supabase.auth.signOut()

    if (error !== null) {
      setIsSigningOut(false)
      toast.error('Gagal keluar. Coba lagi sebentar.')
      return
    }

    router.push('/login')
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="Menu akun"
        >
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">{initialsFrom(email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{email}</span>
          <span className="text-muted-foreground block text-xs">
            {ROLE_LABELS[role]}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={isSigningOut} onSelect={() => void handleSignOut()}>
          <LogOut className="size-4" />
          {isSigningOut ? 'Sedang keluar…' : 'Keluar'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
