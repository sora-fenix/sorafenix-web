import type { Metadata } from 'next'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Gagal masuk' }

const REASONS: Record<string, string> = {
  missing_code: 'Tautan yang Anda buka tidak lengkap.',
  invalid_code: 'Tautan masuk sudah kedaluwarsa atau pernah dipakai.',
}

type AuthErrorPageProps = {
  searchParams: Promise<{ reason?: string }>
}

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const { reason } = await searchParams
  const detail =
    reason === undefined ? undefined : REASONS[reason]

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold">Gagal masuk</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {detail ?? 'Tautan masuk tidak dapat diproses.'} Silakan minta tautan baru.
        </p>
        <Button asChild className="mt-6">
          <Link href="/login">Kembali ke halaman masuk</Link>
        </Button>
      </div>
    </main>
  )
}
