import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('dashboard').label }

export default function DashboardPage() {
  return (
    <ModulePlaceholder
      segment="dashboard"
      emptyTitle="Belum ada data untuk ditampilkan"
      emptyDescription="Angka di dasbor akan muncul setelah kampanye pertama Anda berjalan dan prospek mulai masuk."
      hint="Menunggu Modul 11 — semua metrik dihitung di server lewat SQL view."
    />
  )
}
