import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * Shared labels and badges. Enum values stay English in the database; only what
 * the user reads is Bahasa Indonesia (CLAUDE.md rule 8).
 */

const LEAD_STATUS_LABELS: Record<string, string> = {
  new: 'Baru',
  qualified: 'Terkualifikasi',
  contacted: 'Dihubungi',
  replied: 'Membalas',
  interested: 'Tertarik',
  meeting: 'Meeting',
  proposal: 'Proposal',
  negotiation: 'Negosiasi',
  won: 'Menang',
  lost: 'Kalah',
  do_not_contact: 'Jangan Hubungi',
}

const LEAD_STATUS_TONE: Record<string, string> = {
  new: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  qualified: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  contacted: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  replied: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  interested: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  meeting: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  proposal: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  negotiation: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  won: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  lost: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  do_not_contact: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
}

export function LeadStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent font-medium', LEAD_STATUS_TONE[status])}
    >
      {LEAD_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

const CATEGORY_LABELS: Record<string, string> = {
  hot: 'Panas',
  warm: 'Hangat',
  cold: 'Dingin',
}

const CATEGORY_TONE: Record<string, string> = {
  hot: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  warm: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  cold: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
}

export function CategoryBadge({ category }: { category: string | null }) {
  if (category === null) return <span className="text-muted-foreground">—</span>
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent font-medium', CATEGORY_TONE[category])}
    >
      {CATEGORY_LABELS[category] ?? category}
    </Badge>
  )
}

const MESSAGE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draf',
  needs_input: 'Butuh Data',
  pending_approval: 'Menunggu Persetujuan',
  approved: 'Disetujui',
  queued: 'Antre',
  sent: 'Terkirim',
  delivered: 'Sampai',
  opened: 'Dibuka',
  replied: 'Dibalas',
  bounced: 'Bounce',
  failed: 'Gagal',
  rejected: 'Ditolak',
}

const MESSAGE_STATUS_TONE: Record<string, string> = {
  needs_input: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  pending_approval: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  bounced: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  replied: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  opened: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
}

export function MessageStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent font-medium', MESSAGE_STATUS_TONE[status])}
    >
      {MESSAGE_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

export const KNOWLEDGE_TYPE_LABELS: Record<string, string> = {
  company_profile: 'Profil Perusahaan',
  catalog: 'Katalog',
  pricelist: 'Daftar Harga',
  faq: 'FAQ',
  case_study: 'Studi Kasus',
  script: 'Skrip Penjualan',
  objection: 'Penanganan Keberatan',
  tnc: 'Syarat & Ketentuan',
}

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  draft: 'Draf',
  running: 'Berjalan',
  paused: 'Dijeda',
  done: 'Selesai',
}

const CAMPAIGN_STATUS_TONE: Record<string, string> = {
  running: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  paused: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  done: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
}

export function CampaignStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent font-medium', CAMPAIGN_STATUS_TONE[status])}
    >
      {CAMPAIGN_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

export const EMAIL_STATUS_LABELS: Record<string, string> = {
  unknown: 'Belum diverifikasi',
  valid: 'Valid',
  invalid: 'Tidak valid',
  bounced: 'Bounce',
}

const EMAIL_STATUS_TONE: Record<string, string> = {
  valid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  invalid: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  bounced: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
}

export function EmailStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent font-medium', EMAIL_STATUS_TONE[status])}
    >
      {EMAIL_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

export const INTEGRATION_STATUS_LABELS: Record<string, string> = {
  connected: 'Terhubung',
  disconnected: 'Belum terhubung',
  error: 'Bermasalah',
}

const INTEGRATION_STATUS_TONE: Record<string, string> = {
  connected: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  disconnected: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  error: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
}

export function IntegrationStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn('border-transparent font-medium', INTEGRATION_STATUS_TONE[status])}
    >
      {INTEGRATION_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

export const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  whatsapp: 'WhatsApp',
  serper: 'Serper',
}

export const SUPPRESSION_KIND_LABELS: Record<string, string> = {
  email: 'Email',
  phone: 'Nomor telepon',
  domain: 'Domain',
}

export const PLAN_LABELS: Record<string, string> = {
  free: 'Gratis',
  pro: 'Pro',
  business: 'Bisnis',
}

export const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
}

/**
 * Where a company or contact came from — the values `companies.source` and
 * `contacts.source` hold, written by whichever intake path stored the row.
 */
export const SOURCE_LABELS: Record<string, string> = {
  serper_places: 'pencarian Maps',
  serper_search: 'pencarian web',
  csv: 'unggahan CSV',
}

/**
 * Provenance, next to the channel badge on a draft awaiting approval.
 *
 * Quiet on purpose — outline, muted, `font-normal`. It is a reminder to the
 * person about to approve a send, not the headline of the card.
 */
export function SourceBadge({ source }: { source: string | null }) {
  if (source === null) return null
  return (
    <Badge variant="outline" className="text-muted-foreground font-normal">
      Sumber: {SOURCE_LABELS[source] ?? source}
    </Badge>
  )
}

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  lead_created: 'Prospek dibuat',
  company_enriched: 'Data perusahaan diperkaya',
  lead_scored: 'Prospek dinilai',
  message_drafted: 'Draf dibuat AI',
  draft_approved: 'Draf disetujui',
  message_sent: 'Pesan terkirim',
  message_opened: 'Pesan dibuka',
  reply_received: 'Balasan masuk',
  reply_classified: 'Balasan diklasifikasi',
  status_changed: 'Status berubah',
  owner_assigned: 'Pemilik ditetapkan',
  note_added: 'Catatan ditambahkan',
  whatsapp_sent: 'WhatsApp terkirim',
  sequence_stopped: 'Urutan dihentikan',
}

export const ACTOR_LABELS: Record<string, string> = {
  ai: 'AI',
  human: 'Manusia',
  system: 'Sistem',
}
