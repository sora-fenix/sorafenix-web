import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CampaignStatusBadge } from '@/components/crm/labels'
import { navItem } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getWorkspaceContext } from '@/lib/auth/session'
import { listCampaigns } from '@/lib/db/queries/records'
import { formatDate, formatNumber } from '@/lib/format'

export const metadata: Metadata = { title: navItem('campaigns').label }

type PageProps = { params: Promise<{ workspace: string }> }

export default async function CampaignsPage({ params }: PageProps) {
  const { workspace: slug } = await params
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('campaigns')
  const rows = await listCampaigns(context.workspace.id)

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Belum ada kampanye"
          description="Kampanye menentukan target pasar, produk yang ditawarkan, dan batas kirim harian untuk setiap prospek."
          hint="Jalankan `pnpm db:seed` untuk mengisi data demo."
        />
      </PageShell>
    )
  }

  return (
    <PageShell title={item.label} description={item.description}>
      <p className="text-muted-foreground mb-3 text-sm">
        {formatNumber(rows.length)} kampanye, terbaru di atas.
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kampanye</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Produk</TableHead>
              <TableHead className="text-right">Prospek</TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                Batas Harian
              </TableHead>
              <TableHead className="hidden lg:table-cell">Dibuat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((campaign) => (
              <TableRow key={campaign.id}>
                <TableCell className="max-w-[18rem] truncate font-medium">
                  {campaign.name}
                </TableCell>
                <TableCell>
                  <CampaignStatusBadge status={campaign.status} />
                </TableCell>
                <TableCell className="text-muted-foreground hidden max-w-[14rem] truncate md:table-cell">
                  {campaign.productName ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(campaign.leadCount)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {formatNumber(campaign.dailyCap)}
                </TableCell>
                <TableCell className="text-muted-foreground hidden text-sm lg:table-cell">
                  {formatDate(campaign.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-muted-foreground/80 mt-4 text-xs">
        Batas harian dihitung per workspace sebelum setiap pengiriman. Kampanye
        yang berjalan tetap tidak bisa mengirim tanpa persetujuan manusia.
      </p>
    </PageShell>
  )
}
