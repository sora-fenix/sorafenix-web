import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { navItem, workspaceHref } from '@/components/layout/nav-items'
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
import { getWorkspaceContext } from '@/lib/auth/session'
import { listCompanies } from '@/lib/db/queries/records'
import { formatNumber } from '@/lib/format'
import { pageRequest } from '@/lib/pagination'

export const metadata: Metadata = { title: navItem('companies').label }

type PageProps = {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CompaniesPage({ params, searchParams }: PageProps) {
  const { workspace: slug } = await params
  const query = await searchParams
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('companies')
  const page = await listCompanies(context.workspace.id, pageRequest(query.page))
  const rows = page.rows
  const basePath = workspaceHref(slug, 'companies')

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Belum ada perusahaan"
          description="Data perusahaan terbentuk dari hasil ingestion, lalu diperkaya otomatis dari website resminya."
          hint="Jalankan `pnpm db:seed` untuk mengisi data demo."
        />
      </PageShell>
    )
  }

  return (
    <PageShell title={item.label} description={item.description}>
      <p className="text-muted-foreground mb-3 text-sm">
        {formatNumber(page.total)} perusahaan, diurutkan menurut nama.
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Perusahaan</TableHead>
              <TableHead className="hidden md:table-cell">Industri</TableHead>
              <TableHead className="hidden sm:table-cell">Kota</TableHead>
              <TableHead className="hidden lg:table-cell">Ukuran</TableHead>
              <TableHead className="text-right">Kontak</TableHead>
              <TableHead className="hidden lg:table-cell">Sumber</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((company) => (
              <TableRow key={company.id}>
                <TableCell className="max-w-[18rem]">
                  <span className="block truncate font-medium">{company.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {company.domain ?? '—'}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-[12rem] truncate md:table-cell">
                  {company.industry ?? '—'}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {company.city ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground hidden text-sm lg:table-cell">
                  {company.sizeBand ?? '—'}
                  {company.employeeCount === null
                    ? ''
                    : ` · ${formatNumber(company.employeeCount)} orang`}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(company.contactCount)}
                </TableCell>
                <TableCell className="text-muted-foreground hidden max-w-[10rem] truncate text-sm lg:table-cell">
                  {company.source ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={page} basePath={basePath} noun="perusahaan" />

    </PageShell>
  )
}
