import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { EmailStatusBadge } from '@/components/crm/labels'
import { navItem } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getWorkspaceContext } from '@/lib/auth/session'
import { listContacts } from '@/lib/db/queries/records'
import { formatDate, formatNumber } from '@/lib/format'

export const metadata: Metadata = { title: navItem('contacts').label }

type PageProps = { params: Promise<{ workspace: string }> }

export default async function ContactsPage({ params }: PageProps) {
  const { workspace: slug } = await params
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('contacts')
  const rows = await listContacts(context.workspace.id)

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Belum ada kontak"
          description="Hanya kontak bisnis yang disimpan: email kantor dan nomor telepon bisnis. Nomor pribadi tidak pernah kami simpan tanpa dasar hukum."
          hint="Jalankan `pnpm db:seed` untuk mengisi data demo."
        />
      </PageShell>
    )
  }

  const optedOut = rows.filter((contact) => contact.optOutAt !== null).length

  return (
    <PageShell title={item.label} description={item.description}>
      <p className="text-muted-foreground mb-3 text-sm">
        {formatNumber(rows.length)} kontak bisnis
        {optedOut === 0
          ? '.'
          : `, ${formatNumber(optedOut)} di antaranya sudah menolak dihubungi.`}
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kontak</TableHead>
              <TableHead className="hidden md:table-cell">Perusahaan</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="hidden lg:table-cell">Status Email</TableHead>
              <TableHead className="hidden sm:table-cell">Telepon</TableHead>
              <TableHead>Opt-out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((contact) => (
              <TableRow key={contact.id}>
                <TableCell className="max-w-[14rem]">
                  <span className="block truncate font-medium">
                    {contact.name ?? 'Tanpa nama'}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {contact.position ?? '—'}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-[14rem] md:table-cell">
                  <span className="block truncate">{contact.companyName ?? '—'}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {contact.companyCity ?? '—'}
                  </span>
                </TableCell>
                <TableCell className="max-w-[16rem] truncate">
                  {contact.email ?? '—'}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <EmailStatusBadge status={contact.emailStatus} />
                </TableCell>
                <TableCell className="hidden text-sm tabular-nums sm:table-cell">
                  {contact.phone ?? '—'}
                </TableCell>
                <TableCell>
                  {contact.optOutAt === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="border-transparent bg-rose-100 font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200"
                    >
                      {formatDate(contact.optOutAt)}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-muted-foreground/80 mt-4 text-xs">
        Kontak yang menolak dihubungi otomatis masuk daftar suppression dan
        dilewati sebelum setiap pengiriman, bukan hanya saat kampanye disusun.
      </p>
    </PageShell>
  )
}
