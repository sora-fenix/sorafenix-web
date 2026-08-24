import type { Metadata } from 'next'
import Link from 'next/link'

import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Masuk' }

type LoginPageProps = {
  searchParams: Promise<{ next?: string }>
}

/** Only relative paths are accepted, so ?next= cannot become an open redirect. */
function safeNext(value: string | undefined): string {
  if (value === undefined) return '/app'
  if (!value.startsWith('/') || value.startsWith('//')) return '/app'
  return value
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="text-xl font-semibold tracking-tight">
            SORA
          </Link>
          <h1 className="mt-6 text-lg font-semibold">Masuk ke akun Anda</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Masukkan email kerja Anda. Kami kirimkan tautan masuk tanpa kata sandi.
          </p>
        </div>

        <LoginForm next={safeNext(params.next)} />

        <p className="text-muted-foreground mt-8 text-center text-xs">
          Dengan masuk, Anda menyetujui bahwa outreach hanya ditujukan ke kontak bisnis.
        </p>
      </div>
    </main>
  )
}
