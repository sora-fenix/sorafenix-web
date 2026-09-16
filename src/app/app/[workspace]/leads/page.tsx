import { Download } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CategoryBadge, LeadStatusBadge } from '@/components/crm/labels'
import { navItem, workspaceApiHref, workspaceHref } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pagination } from '@/components/layout/pagination'
import { buttonVariants } from '@/components/ui/button'
import { getWorkspaceContext } from '@/lib/auth/session'
import { listLeads } from '@/lib/db/queries/records'
import { formatNumber, formatRelativeDay, isOverdue, truncate } from '@/lib/format'
import { pageRequest } from '@/lib/pagination'

export const metadata: Metadata = { title: navItem('leads').label }

type PageProps = {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function LeadsPage({ params, searchParams }: PageProps) {
  const { workspace: slug } = await params
  const query = await searchParams
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('leads')
  const page = await listLeads(context.workspace.id, pageRequest(query.page))
  const rows = page.rows
  const basePath = workspaceHref(slug, 'leads')

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Belum ada prospek"
          description="Prospek akan muncul otomatis setelah n8n mengirim hasil pencarian ke SORA dan lolos proses dedupe."
          hint="Jalankan `pnpm db:seed` untuk mengisi data demo."
        />
      </PageShell>
    )
  }

  return (
    <PageShell title={item.label} description={item.description}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {formatNumber(page.total)} prospek, diurutkan dari skor tertinggi.
        </p>
        {/*
          A plain link, not a button with a fetch: the browser downloads it, so
          this screen stays a server component. The file holds every lead in the
          workspace, not just this page.
        */}
        <a
          href={workspaceApiHref(slug, 'leads/export')}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          download
        >
          <Download className="size-4" aria-hidden />
          Unduh CSV ({formatNumber(page.total)})
        </a>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Perusahaan</TableHead>
              <TableHead className="hidden md:table-cell">Kontak</TableHead>
              <TableHead className="text-right">Skor</TableHead>
              <TableHead>Kategori</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Kampanye</TableHead>
              <TableHead className="hidden sm:table-cell">Tindakan Berikutnya</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((lead) => (
              <TableRow key={lead.id}>
                <TableCell className="max-w-[16rem]">
                  <span className="block truncate font-medium">
                    {lead.companyName ?? 'Tanpa nama'}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {lead.companyIndustry ?? '—'}
                    {lead.companyCity === null ? '' : ` · ${lead.companyCity}`}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-[14rem] md:table-cell">
                  <span className="block truncate">{lead.contactName ?? '—'}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {lead.contactPosition ?? '—'}
                  </span>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {lead.score ?? '—'}
                </TableCell>
                <TableCell>
                  <CategoryBadge category={lead.category} />
                </TableCell>
                <TableCell>
                  <LeadStatusBadge status={lead.status} />
                </TableCell>
                <TableCell className="text-muted-foreground hidden max-w-[12rem] truncate text-sm lg:table-cell">
                  {lead.campaignName ?? '—'}
                </TableCell>
                <TableCell
                  className={
                    isOverdue(lead.nextActionAt)
                      ? 'text-destructive hidden text-sm font-medium sm:table-cell'
                      : 'text-muted-foreground hidden text-sm sm:table-cell'
                  }
                >
                  {formatRelativeDay(lead.nextActionAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} basePath={basePath} noun="prospek" />

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Alasan skor teratas</h2>
        <ul className="space-y-2">
          {rows.slice(0, 3).map((lead) => (
            <li key={lead.id} className="rounded-lg border p-3 text-sm">
              <span className="font-medium">{lead.companyName}</span>{' '}
              <span className="text-muted-foreground tabular-nums">({lead.score})</span>
              <p className="text-muted-foreground mt-1">
                {truncate(lead.scoreReason, 220)}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </PageShell>
  )
}
