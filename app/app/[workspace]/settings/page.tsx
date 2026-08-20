import type { Metadata } from 'next'

import { ModulePlaceholder } from '@/components/layout/module-placeholder'
import { navItem } from '@/components/layout/nav-items'

export const metadata: Metadata = { title: navItem('settings').label }

export default function SettingsPage() {
  return (
    <ModulePlaceholder
      segment="settings"
      emptyTitle="Pengaturan belum tersedia"
      emptyDescription="Kelola nama workspace, anggota tim dan perannya, integrasi Gmail dan WhatsApp, serta batas pengiriman harian."
      hint="Menunggu slice Pengaturan."
    />
  )
}
