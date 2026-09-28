'use client'

import { Download, Upload } from 'lucide-react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { importLeads, type ImportLeadsState } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CampaignOption } from '@/lib/db/queries/records'
import { formatNumber } from '@/lib/format'
import { MAX_CSV_UPLOAD_BYTES, MAX_INGEST_ITEMS } from '@/lib/leads/limits'

/**
 * The upload form. A client component because it needs the pending state and the
 * result of the action; everything else on the Prospek screen stays RSC.
 *
 * The select and the checkbox are plain HTML rather than shadcn primitives: the
 * project has neither generated, and `.claude/rules/ui.md` says to add those with
 * the CLI rather than by hand. A native select is also the control a phone
 * renders best.
 */

const INITIAL: ImportLeadsState = { status: 'idle' }

const MAX_MEGABYTES = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024))

/** The provenance statement. Its wording is the record, so it is not paraphrased. */
const CONFIRMATION_LABEL =
  'Saya menegaskan seluruh kontak dalam berkas ini adalah kontak bisnis yang sah untuk dihubungi, bukan nomor pribadi.'

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      <Upload className="size-4" aria-hidden />
      {pending ? 'Mengunggah…' : 'Unggah dan proses'}
    </Button>
  )
}

type Props = {
  workspaceSlug: string
  campaigns: readonly CampaignOption[]
}

export function ImportLeadsForm({ workspaceSlug, campaigns }: Props) {
  const [state, formAction] = useActionState(importLeads, INITIAL)

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="campaignId">Masukkan ke kampanye</Label>
          <select
            id="campaignId"
            name="campaignId"
            required
            defaultValue=""
            className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <option value="" disabled>
              Pilih kampanye…
            </option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="file">Berkas CSV</Label>
          <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <input
          id="confirmation"
          name="confirmation"
          type="checkbox"
          required
          className="border-input accent-primary mt-0.5 size-4 shrink-0 rounded border"
        />
        <Label htmlFor="confirmation" className="text-muted-foreground text-xs leading-relaxed font-normal">
          {CONFIRMATION_LABEL}
        </Label>
      </div>

      {state.status === 'error' ? (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      ) : null}

      {state.status === 'done' ? (
        <div role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {formatNumber(state.inserted)} prospek baru masuk,{' '}
            {formatNumber(state.duplicates)} digabung karena sudah ada.
          </p>
          {state.rejected.length === 0 ? null : (
            <>
              <p className="text-muted-foreground mt-2 text-xs">
                Baris yang dilewati:
              </p>
              <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                {state.rejected.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {state.hiddenRejections === 0 ? null : (
                <p className="text-muted-foreground mt-1 text-xs">
                  dan {formatNumber(state.hiddenRejections)} baris lain.
                </p>
              )}
            </>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton />
        <a
          href="/templates/contoh-prospek.csv"
          download
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs underline underline-offset-4"
        >
          <Download className="size-3.5" aria-hidden />
          Unduh berkas contoh
        </a>
      </div>

      <p className="text-muted-foreground/80 text-xs">
        Kolom wajib: Nama Usaha. Kolom lain — Kategori Usaha, Alamat, Kota,
        Rating, Jumlah Review, Website, Email, Telepon, WhatsApp, Sumber —
        diisi kalau ada. Kolom yang tidak dikenali diabaikan, jadi hasil unduhan
        dari layar ini bisa langsung diunggah kembali. Maksimal{' '}
        {formatNumber(MAX_INGEST_ITEMS)} baris dan {MAX_MEGABYTES} MB per berkas.
      </p>
    </form>
  )
}
