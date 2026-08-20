import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('contacts').label }

export default function ContactsPage() {
  return (
    <ModulePlaceholder
      segment="contacts"
      emptyTitle="Belum ada kontak"
      emptyDescription="Hanya kontak bisnis yang disimpan: email kantor dan nomor telepon bisnis. Nomor pribadi tidak pernah kami simpan tanpa dasar hukum."
      hint="Menunggu Modul 2 (enrichment)."
    />
  )
}
