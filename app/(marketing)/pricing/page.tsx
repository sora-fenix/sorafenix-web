import type { Metadata } from 'next'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Harga' }

export default function PricingPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Harga</h1>
      <p className="text-muted-foreground mt-3 max-w-2xl text-sm">
        Paket dan harga belum ditetapkan. Halaman ini akan diisi sebelum peluncuran.
      </p>

      <div className="mt-10 rounded-xl border border-dashed px-6 py-14 text-center">
        <p className="text-sm font-medium">Belum tersedia</p>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm">
          Hubungi kami kalau Anda ingin mencoba SORA lebih awal.
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/">Kembali ke beranda</Link>
        </Button>
      </div>
    </main>
  )
}
