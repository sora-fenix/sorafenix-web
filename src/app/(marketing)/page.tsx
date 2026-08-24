import { ArrowRight, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

const PILLARS = [
  {
    icon: Workflow,
    title: 'Satu alur, ujung ke ujung',
    body: 'Cari prospek, perkaya datanya, kualifikasi dengan AI, susun pesan, kirim, lalu baca balasannya — dalam satu sistem.',
  },
  {
    icon: ShieldCheck,
    title: 'Manusia tetap memegang kendali',
    body: 'AI menyusun draf, Anda yang menyetujui. Tidak ada pesan keluar tanpa persetujuan, dan permintaan berhenti langsung dihormati.',
  },
  {
    icon: Sparkles,
    title: 'AI yang tidak mengarang',
    body: 'Harga, spesifikasi, dan klaim hanya diambil dari basis pengetahuan Anda. Kalau datanya tidak ada, draf ditandai — bukan ditebak.',
  },
]

export default function LandingPage() {
  return (
    <main>
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="text-lg font-semibold tracking-tight">SORA</span>
        <nav className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href="/pricing">Harga</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/login">Masuk</Link>
          </Button>
        </nav>
      </header>

      <section className="mx-auto w-full max-w-5xl px-4 pt-16 pb-20 sm:px-6 sm:pt-24">
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
          AI sales agent yang bekerja seperti tim sales Anda — bukan seperti robot spam.
        </h1>
        <p className="text-muted-foreground mt-5 max-w-2xl text-base sm:text-lg">
          SORA menemukan calon pelanggan bisnis, menilai kualitasnya dengan alasan yang
          bisa Anda periksa, menyusun pesan yang personal, dan menunggu persetujuan Anda
          sebelum mengirim apa pun.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/login">
              Mulai sekarang
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">Lihat harga</Link>
          </Button>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-16 sm:grid-cols-3 sm:px-6">
          {PILLARS.map((pillar) => (
            <div key={pillar.title}>
              <pillar.icon className="text-muted-foreground size-5" />
              <h2 className="mt-4 text-sm font-semibold">{pillar.title}</h2>
              <p className="text-muted-foreground mt-2 text-sm">{pillar.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t">
        <div className="text-muted-foreground mx-auto w-full max-w-5xl px-4 py-8 text-xs sm:px-6">
          SORA hanya menghubungi kontak bisnis. Setiap email menyertakan tautan berhenti
          berlangganan, dan permintaan berhenti diproses seketika.
        </div>
      </footer>
    </main>
  )
}
