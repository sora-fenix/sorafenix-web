import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { KNOWLEDGE_TYPE_LABELS } from '@/components/crm/labels'
import { navItem } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'
import { Badge } from '@/components/ui/badge'
import { getWorkspaceContext } from '@/lib/auth/session'
import { listKnowledgeDocs, type KnowledgeDocRow } from '@/lib/db/queries/records'
import { formatDate, formatNumber, truncate } from '@/lib/format'

export const metadata: Metadata = { title: navItem('knowledge').label }

type PageProps = { params: Promise<{ workspace: string }> }

/** Preserves the query's `order by type`, so the headings stay stable. */
function groupByType(rows: KnowledgeDocRow[]): [string, KnowledgeDocRow[]][] {
  const groups = new Map<string, KnowledgeDocRow[]>()
  for (const doc of rows) {
    const bucket = groups.get(doc.type)
    if (bucket === undefined) groups.set(doc.type, [doc])
    else bucket.push(doc)
  }
  return [...groups]
}

export default async function KnowledgePage({ params }: PageProps) {
  const { workspace: slug } = await params
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('knowledge')
  const rows = await listKnowledgeDocs(context.workspace.id)

  if (rows.length === 0) {
    return (
      <PageShell title={item.label} description={item.description}>
        <EmptyState
          icon={item.icon}
          title="Basis pengetahuan masih kosong"
          description="Unggah profil perusahaan, katalog, pricelist, FAQ, dan skrip penjualan. AI hanya boleh menyebut fakta yang ada di sini."
          hint="Tanpa dokumen, AI akan menandai draf sebagai needs_input."
        />
      </PageShell>
    )
  }

  const inactive = rows.filter((doc) => !doc.isActive).length

  return (
    <PageShell title={item.label} description={item.description}>
      <p className="text-muted-foreground mb-4 text-sm">
        {formatNumber(rows.length)} dokumen
        {inactive === 0 ? '' : `, ${formatNumber(inactive)} nonaktif`}. Hanya
        dokumen aktif yang boleh dikutip AI.
      </p>

      <div className="space-y-6">
        {groupByType(rows).map(([type, docs]) => (
          <section key={type}>
            <h2 className="mb-2 text-sm font-semibold">
              {KNOWLEDGE_TYPE_LABELS[type] ?? type}
            </h2>
            <ul className="space-y-2">
              {docs.map((doc) => (
                <li key={doc.id} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 truncate font-medium">{doc.title}</p>
                    {doc.isActive ? (
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-transparent bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                      >
                        Aktif
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0 font-medium">
                        Nonaktif
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-1.5 text-sm">
                    {truncate(doc.content, 240)}
                  </p>
                  <p className="text-muted-foreground/80 mt-3 text-xs">
                    Diperbarui {formatDate(doc.updatedAt)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="text-muted-foreground/80 mt-6 text-xs">
        AI tidak boleh mengarang harga, fitur, diskon, spesifikasi, atau waktu
        pengiriman. Fakta yang tidak ada di sini akan dibiarkan kosong dan
        drafnya ditandai butuh data.
      </p>
    </PageShell>
  )
}
