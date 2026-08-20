import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('campaigns').label }

export default function CampaignsPage() {
  return (
    <ModulePlaceholder
      segment="campaigns"
      emptyTitle="Belum ada kampanye"
      emptyDescription="Kampanye menentukan target pasar, produk yang ditawarkan, dan batas kirim harian untuk setiap prospek."
      hint="Menunggu slice Kampanye."
    />
  )
}
