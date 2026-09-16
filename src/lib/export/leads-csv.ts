import type { LeadExportRow } from '@/lib/db/queries/records'

import {
  type CsvColumn,
  dateCell,
  numberCell,
  phoneCell,
  textCell,
  toCsv,
} from './csv'

/**
 * The lead export's column layout.
 *
 * Headers are Bahasa Indonesia because a salesperson opens this file, and it is
 * user-facing text (CLAUDE.md rule 8). The keys, the enum values and this code
 * stay English.
 *
 * Separate from `csv.ts` so the serialiser stays about CSV and this stays about
 * leads: adding a column is a one-line change here and touches nothing that the
 * quoting and locale tests cover.
 */

/** Bahasa Indonesia labels for the two enums that reach this file. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  hot: 'Panas',
  warm: 'Hangat',
  cold: 'Dingin',
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
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

export const LEAD_EXPORT_COLUMNS: readonly CsvColumn<LeadExportRow>[] = [
  { header: 'Nama Usaha', cell: (row) => textCell(row.companyName) },
  { header: 'Kategori Usaha', cell: (row) => textCell(row.industry) },
  { header: 'Kota', cell: (row) => textCell(row.city) },
  { header: 'Rating', cell: (row) => numberCell(row.rating) },
  { header: 'Jumlah Review', cell: (row) => numberCell(row.reviewCount) },
  { header: 'Website', cell: (row) => textCell(row.website) },
  { header: 'Nama Kontak', cell: (row) => textCell(row.contactName) },
  { header: 'Email', cell: (row) => textCell(row.email) },
  // Phone and WhatsApp, not the rest: these are the ones Excel would otherwise
  // read as a formula and hand back as 6.28E+12.
  { header: 'Telepon', cell: (row) => phoneCell(row.phone) },
  { header: 'WhatsApp', cell: (row) => phoneCell(row.whatsapp) },
  { header: 'Skor', cell: (row) => numberCell(row.score) },
  {
    header: 'Kategori Prospek',
    cell: (row) => textCell(row.category === null ? '' : CATEGORY_LABELS[row.category] ?? row.category),
  },
  { header: 'Tahap', cell: (row) => textCell(STATUS_LABELS[row.status] ?? row.status) },
  { header: 'Alasan Skor', cell: (row) => textCell(row.scoreReason) },
  { header: 'Kampanye', cell: (row) => textCell(row.campaignName) },
  { header: 'Sumber', cell: (row) => textCell(row.sourceUrl) },
  { header: 'Tanggal Masuk', cell: (row) => dateCell(row.createdAt) },
]

export function leadsToCsv(rows: readonly LeadExportRow[]): string {
  return toCsv(LEAD_EXPORT_COLUMNS, rows)
}
