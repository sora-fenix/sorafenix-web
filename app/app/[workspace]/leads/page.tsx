import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('leads').label }

export default function LeadsPage() {
  return (
    <ModulePlaceholder
      segment="leads"
      emptyTitle="Belum ada prospek"
      emptyDescription="Prospek akan muncul otomatis setelah n8n mengirim hasil pencarian ke SORA dan lolos proses dedupe."
      hint="Menunggu Modul 1 (ingestion) dan Modul 3 (kualifikasi AI)."
    />
  )
}
