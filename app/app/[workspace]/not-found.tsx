import Link from 'next/link'

import { Button } from '@/components/ui/button'

export default function WorkspaceNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-20 text-center">
      <h1 className="text-lg font-semibold">Workspace tidak ditemukan</h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Workspace ini tidak ada, atau akun Anda bukan anggotanya.
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link href="/app">Kembali ke workspace saya</Link>
      </Button>
    </div>
  )
}
