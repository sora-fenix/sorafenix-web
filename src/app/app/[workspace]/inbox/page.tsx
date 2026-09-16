import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CHANNEL_LABELS, MessageStatusBadge } from '@/components/crm/labels'
import { navItem, workspaceHref } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/layout/pagination'
import { getWorkspaceContext } from '@/lib/auth/session'
import { listInbox } from '@/lib/db/queries/records'
import { formatDateTime, formatNumber, truncate } from '@/lib/format'
import { pageRequest } from '@/lib/pagination'

export const metadata: Metadata = { title: navItem('inbox').label }

type PageProps = {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function InboxPage({ params, searchParams }: PageProps) {
  const { workspace: slug } = await params
  const query = await searchParams
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('inbox')
  const page = await listInbox(context.workspace.id, pageRequest(query.page))
  const rows = page.rows
  const basePath = workspaceHref(slug, 'inbox')

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Belum ada balasan"
          description="Balasan email dan WhatsApp akan muncul di sini lengkap dengan klasifikasi otomatis dan saran tindak lanjut."
          hint="Jalankan `pnpm db:seed` untuk mengisi data demo."
        />
      </PageShell>
    )
  }

  return (
    <PageShell title={item.label} description={item.description}>
      <p className="text-muted-foreground mb-3 text-sm">
        {formatNumber(page.total)} balasan masuk, terbaru di atas.
      </p>

      <ul className="space-y-3">
        {rows.map((message) => (
          <li key={message.id} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {message.contactName ?? 'Kontak tidak diketahui'}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {message.companyName ?? '—'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
              {formatDateTime(message.sentAt ?? message.createdAt)}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground/80 mt-4 text-xs">
        Balasan yang berisi permintaan berhenti dihubungi langsung masuk daftar
        suppression dan menghentikan seluruh urutan untuk kontak tersebut.
      </p>
      <Pagination page={page} basePath={basePath} noun="balasan" />

    </PageShell>
  )
}
