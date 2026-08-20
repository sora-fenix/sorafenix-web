import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('companies').label }

export default function CompaniesPage() {
  return (
    <ModulePlaceholder
      segment="companies"
      emptyTitle="Belum ada perusahaan"
      emptyDescription="Data perusahaan terbentuk dari hasil ingestion, lalu diperkaya otomatis dari website resminya."
      hint="Menunggu Modul 1 (ingestion) dan Modul 2 (enrichment)."
    />
  )
}
