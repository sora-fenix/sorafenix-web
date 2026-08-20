import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('approvals').label }

export default function ApprovalsPage() {
  return (
    <ModulePlaceholder
      segment="approvals"
      emptyTitle="Tidak ada draf yang menunggu"
      emptyDescription="Setiap pesan dari AI wajib Anda setujui sebelum dikirim. Draf yang datanya belum lengkap ditandai dan tidak bisa dikirim."
      hint="Menunggu Modul 5 (content generator). Mode otonom tetap nonaktif di MVP."
    />
  )
}
