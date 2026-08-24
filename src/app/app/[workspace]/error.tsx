'use client'

import { AlertTriangle } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

type WorkspaceErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

export default function WorkspaceError({ error, reset }: WorkspaceErrorProps) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-20 text-center">
      <div className="bg-destructive/10 text-destructive mb-4 flex size-11 items-center justify-center rounded-full">
        <AlertTriangle className="size-5" />
      </div>
      <h1 className="text-lg font-semibold">Terjadi kesalahan</h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Halaman ini gagal dimuat. Coba muat ulang; kalau masih gagal, hubungi tim Anda.
      </p>
      {error.digest === undefined ? null : (
        <p className="text-muted-foreground/70 mt-3 font-mono text-xs">
          Kode: {error.digest}
        </p>
      )}
      <Button onClick={reset} className="mt-6">
        Coba lagi
      </Button>
    </div>
  )
}
