import {
  BookOpen,
  Building2,
  CheckCircle2,
  Inbox,
  LayoutDashboard,
  Megaphone,
  Settings,
  Target,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** URL segments stay English; only the labels are localised. */
export const NAV_SEGMENTS = [
  'dashboard',
  'leads',
  'companies',
  'contacts',
  'campaigns',
  'inbox',
  'approvals',
  'knowledge',
  'settings',
] as const

export type NavSegment = (typeof NAV_SEGMENTS)[number]

export type NavItem = {
  segment: NavSegment
  label: string
  icon: LucideIcon
  /** Sub-heading on the module page; also the collapsed sidebar tooltip source. */
  description: string
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    segment: 'dashboard',
    label: 'Dasbor',
    icon: LayoutDashboard,
    description:
      'Ringkasan performa: total prospek, email dan WhatsApp terkirim, balasan, dan konversi.',
  },
  {
    segment: 'leads',
    label: 'Prospek',
    icon: Target,
    description:
      'Semua prospek beserta skor, kategori, dan alasan kualifikasi dari AI.',
  },
  {
    segment: 'companies',
    label: 'Perusahaan',
    icon: Building2,
    description: 'Data perusahaan hasil pencarian dan pengayaan otomatis.',
  },
  {
    segment: 'contacts',
    label: 'Kontak',
    icon: Users,
    description: 'Kontak bisnis: nama, jabatan, email kantor, dan nomor bisnis.',
  },
  {
    segment: 'campaigns',
    label: 'Kampanye',
    icon: Megaphone,
    description: 'Kampanye outreach beserta target pasar dan batas kirim harian.',
  },
  {
    segment: 'inbox',
    label: 'Kotak Masuk',
    icon: Inbox,
    description: 'Balasan email dan WhatsApp yang sudah diklasifikasi otomatis.',
  },
  {
    segment: 'approvals',
    label: 'Persetujuan',
    icon: CheckCircle2,
    description: 'Draf dari AI yang menunggu persetujuan Anda sebelum dikirim.',
  },
  {
    segment: 'knowledge',
    label: 'Basis Pengetahuan',
    icon: BookOpen,
    description:
      'Profil perusahaan, katalog, pricelist, dan FAQ — satu-satunya sumber fakta untuk AI.',
  },
  {
    segment: 'settings',
    label: 'Pengaturan',
    icon: Settings,
    description: 'Workspace, anggota tim, integrasi, dan batas pengiriman.',
  },
]

const BY_SEGMENT = new Map<NavSegment, NavItem>(
  NAV_ITEMS.map((item) => [item.segment, item]),
)

/** Typed lookup. The NavSegment parameter makes a miss a programming error. */
export function navItem(segment: NavSegment): NavItem {
  const item = BY_SEGMENT.get(segment)
  if (item === undefined) {
    throw new Error(`nav-items.ts: no entry for segment "${segment}"`)
  }
  return item
}

export function workspaceHref(slug: string, segment: string): string {
  return `/app/${slug}/${segment}`
}
