'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { workspaceHref } from '@/components/layout/nav-items'
import { can } from '@/lib/auth/permissions'
import { getCurrentUser, getWorkspaceContext } from '@/lib/auth/session'
import type { RejectionReason } from '@/lib/leads/ingest'
import { type CsvUploadError, importLeadsFromCsv } from '@/lib/leads/csv-upload'
import { MAX_CSV_UPLOAD_BYTES, MAX_INGEST_ITEMS } from '@/lib/leads/limits'

/**
 * CSV upload from the Prospek screen.
 *
 * Thin, like `src/app/app/actions.ts`: authenticate, authorise, validate,
 * delegate, translate. The parsing lives in `lib/leads/csv-import.ts` and the
 * writing in `lib/leads/csv-upload.ts`, which is what lets both be tested
 * without a request.
 *
 * The workspace is resolved from the slug through the session, never taken from
 * the form. A workspace id posted by the browser is an id the browser chose.
 */

const MAX_REPORTED_REJECTIONS = 50

const MAX_MEGABYTES = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024))

const importSchema = z.object({
  workspaceSlug: z.string().min(1),
  campaignId: z.uuid('Pilih kampanye tujuan terlebih dahulu.'),
  file: z
    .instanceof(File, { message: 'Pilih berkas CSV yang ingin diunggah.' })
    .refine((file) => file.size > 0, 'Berkas yang Anda pilih kosong.')
    // Before `arrayBuffer()`, not after: reading it first would pull the whole
    // file into memory to then say it was too big.
    .refine(
      (file) => file.size <= MAX_CSV_UPLOAD_BYTES,
      `Berkas terlalu besar. Maksimal ${MAX_MEGABYTES} MB.`,
    ),
  /**
   * The provenance capture `.claude/rules/outreach.md` asks for. `required` on
   * the input is a convenience for the user; this is the check that counts,
   * because a form can be posted without a browser.
   */
  confirmation: z.literal(
    'on',
    'Centang pernyataan bahwa kontak di berkas ini adalah kontak bisnis.',
  ),
})

export type ImportLeadsState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'done'
      inserted: number
      duplicates: number
      /** Ready-to-render lines. Line number and reason only — never a value. */
      rejected: string[]
      /** Rejections beyond `MAX_REPORTED_REJECTIONS`, summarised rather than listed. */
      hiddenRejections: number
    }

/** Bahasa Indonesia for the user; the machine codes stay in `lib/` (rule 8). */
const ERROR_COPY: Record<CsvUploadError, string> = {
  empty_file: 'Berkas itu kosong. Pastikan Anda memilih berkas CSV yang benar.',
  file_too_large: `Berkas terlalu besar. Maksimal ${MAX_MEGABYTES} MB.`,
  not_utf8:
    'Berkas tidak bisa dibaca. Simpan ulang dari Excel dengan format "CSV UTF-8", lalu unggah lagi.',
  header_missing:
    'Kolom "Nama Usaha" tidak ditemukan di baris pertama. Pakai berkas contoh sebagai acuan.',
  no_rows: 'Tidak ada baris data di bawah judul kolom.',
  too_many_rows: `Terlalu banyak baris. Maksimal ${MAX_INGEST_ITEMS} baris per unggahan — bagi berkasnya.`,
  too_many_fields: 'Terlalu banyak kolom. Pakai berkas contoh sebagai acuan.',
  unterminated_quote:
    'Ada tanda kutip (") yang tidak ditutup, jadi isi berkas tercampur jadi satu. Periksa tanda kutip di berkas Anda, lalu unggah lagi.',
  campaign_not_found: 'Kampanye itu tidak ada di workspace ini.',
  db_error: 'Gagal menyimpan prospek. Coba lagi dalam beberapa saat.',
}

const REJECTION_COPY: Record<RejectionReason, string> = {
  company_name_missing: 'nama usaha kosong',
  no_contact_channel: 'tidak ada website, telepon, atau email',
}

export async function importLeads(
  _prev: ImportLeadsState,
  formData: FormData,
): Promise<ImportLeadsState> {
  const user = await getCurrentUser()
  if (user === null) redirect('/login?next=/app')

  const parsed = importSchema.safeParse({
    workspaceSlug: formData.get('workspaceSlug'),
    campaignId: formData.get('campaignId'),
    file: formData.get('file'),
    confirmation: formData.get('confirmation'),
  })
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      status: 'error',
      message: first?.message ?? 'Data yang Anda masukkan tidak valid.',
    }
  }

  // Membership and permission in one step. A non-member and a viewer get the
  // same refusal as a slug that does not exist, so neither can probe the other.
  const context = await getWorkspaceContext(parsed.data.workspaceSlug)
  if (context === null || !can(context.role, 'lead:write')) {
    return {
      status: 'error',
      message: 'Anda tidak punya akses untuk menambah prospek di workspace ini.',
    }
  }

  const result = await importLeadsFromCsv({
    workspaceId: context.workspace.id,
    campaignId: parsed.data.campaignId,
    bytes: new Uint8Array(await parsed.data.file.arrayBuffer()),
  })

  if (!result.ok) {
    return { status: 'error', message: ERROR_COPY[result.error] }
  }

  revalidatePath(workspaceHref(context.workspace.slug, 'leads'))

  const rejected = result.value.rejected
    .slice(0, MAX_REPORTED_REJECTIONS)
    .map((rejection) => `Baris ${rejection.line} — ${REJECTION_COPY[rejection.reason]}`)

  return {
    status: 'done',
    inserted: result.value.inserted,
    duplicates: result.value.duplicates,
    rejected,
    hiddenRejections: result.value.rejected.length - rejected.length,
  }
}
