import { AlertTriangle } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CHANNEL_LABELS, MessageStatusBadge, SourceBadge } from '@/components/crm/labels'
import { navItem, workspaceHref } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/layout/pagination'
import { getWorkspaceContext } from '@/lib/auth/session'
import { listApprovals } from '@/lib/db/queries/records'
import { formatDateTime, formatNumber, truncate } from '@/lib/format'
import { pageRequest } from '@/lib/pagination'

export const metadata: Metadata = { title: navItem('approvals').label }

type PageProps = {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ApprovalsPage({ params, searchParams }: PageProps) {
  const { workspace: slug } = await params
  const query = await searchParams
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('approvals')
  const page = await listApprovals(context.workspace.id, pageRequest(query.page))
  const rows = page.rows
  const basePath = workspaceHref(slug, 'approvals')

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Tidak ada draf yang menunggu"
          description="Setiap pesan dari AI wajib Anda setujui sebelum dikirim. Draf yang datanya belum lengkap ditandai dan tidak bisa dikirim."
          hint="Jalankan `pnpm db:seed` untuk mengisi data demo."
        />
      </PageShell>
    )
  }

  const needsInput = rows.filter((message) => message.status === 'needs_input').length

  return (
    <PageShell title={item.label} description={item.description}>
      {needsInput === 0 ? (
        <p className="text-muted-foreground mb-3 text-sm">
          {formatNumber(page.total)} draf menunggu persetujuan Anda.
        </p>
      ) : (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <p>
            <span className="font-medium">
              {formatNumber(needsInput)} draf butuh data tambahan
            </span>{' '}
            dari {formatNumber(rows.length)} draf yang menunggu. AI tidak
            menemukan faktanya di basis pengetahuan, jadi bagian itu sengaja
            dikosongkan dan draf tidak boleh dikirim apa adanya.
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {rows.map((message) => (
          <li
            key={message.id}
            className={
              message.status === 'needs_input'
                ? 'rounded-lg border border-amber-300 p-4 dark:border-amber-900'
                : 'rounded-lg border p-4'
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {message.contactName ?? 'Kontak tidak diketahui'}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {message.companyName ?? '—'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <SourceBadge source={message.contactSource} />
                <Badge variant="outline" className="font-medium">
                  {CHANNEL_LABELS[message.channel] ?? message.channel}
                </Badge>
                <MessageStatusBadge status={message.status} />
              </div>
            </div>

            {message.subject === null ? null : (
              <p className="mt-3 text-sm font-medium">{message.subject}</p>
            )}
            <p className="text-muted-foreground mt-1 text-sm">
              {truncate(message.body, 260)}
            </p>
            <p className="text-muted-foreground/80 mt-3 text-xs">
              Dibuat {formatDateTime(message.createdAt)}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground/80 mt-4 text-xs">
        Draf di sini ditulis AI dan menunggu orang. Tombol setujui dan tolak
        menyusul bersama jalur pengiriman di Modul 6/7. Sampai saat itu layar ini
        hanya menampilkan antrean — tidak ada jalur kirim otomatis.
      </p>
      <Pagination page={page} basePath={basePath} noun="draf" />

    </PageShell>
  )
}
