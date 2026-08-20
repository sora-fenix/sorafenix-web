import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('inbox').label }

export default function InboxPage() {
  return (
    <ModulePlaceholder
      segment="inbox"
      emptyTitle="Belum ada balasan"
      emptyDescription="Balasan email dan WhatsApp akan muncul di sini lengkap dengan klasifikasi otomatis dan saran tindak lanjut."
      hint="Menunggu Modul 9 (reply reader) dan Modul 10 (update status otomatis)."
    />
  )
}
