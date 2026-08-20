import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { Toaster } from '@/components/ui/sonner'

import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'SORA — AI Sales Agent',
    template: '%s · SORA',
  },
  description:
    'Platform AI sales agent: temukan prospek, kualifikasi otomatis, dan kirim outreach yang selalu lewat persetujuan manusia.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-svh antialiased">
        {children}
        <Toaster position="top-center" />
      </body>
    </html>
  )
}
