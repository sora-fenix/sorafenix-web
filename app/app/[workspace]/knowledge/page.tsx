import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('knowledge').label }

export default function KnowledgePage() {
  return (
    <ModulePlaceholder
      segment="knowledge"
      emptyTitle="Basis pengetahuan masih kosong"
      emptyDescription="Unggah profil perusahaan, katalog, pricelist, FAQ, dan skrip penjualan. AI hanya boleh menyebut fakta yang ada di sini."
      hint="Menunggu slice Basis Pengetahuan. Tanpa dokumen, AI akan menandai draf sebagai needs_input."
    />
  )
}
