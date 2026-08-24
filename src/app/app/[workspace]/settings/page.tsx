import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import {
  IntegrationStatusBadge,
  PLAN_LABELS,
  PROVIDER_LABELS,
  SUPPRESSION_KIND_LABELS,
} from '@/components/crm/labels'
import { navItem } from '@/components/layout/nav-items'
import { PageShell } from '@/components/layout/page-shell'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listMembersWithEmail } from '@/lib/auth/members'
import { ROLE_LABELS, isRole } from '@/lib/auth/permissions'
import { getWorkspaceContext } from '@/lib/auth/session'
import {
  countProducts,
  listIntegrations,
  listSuppressions,
} from '@/lib/db/queries/records'
import { formatDate, formatNumber } from '@/lib/format'

export const metadata: Metadata = { title: navItem('settings').label }

type PageProps = { params: Promise<{ workspace: string }> }

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{description}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}

function roleLabel(role: string): string {
  return isRole(role) ? ROLE_LABELS[role] : role
}

export default async function SettingsPage({ params }: PageProps) {
  const { workspace: slug } = await params
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const item = navItem('settings')
  const { workspace, user } = context

  const [members, integrations, suppressions, productCount] = await Promise.all([
    listMembersWithEmail(workspace.id),
    listIntegrations(workspace.id),
    listSuppressions(workspace.id),
    countProducts(workspace.id),
  ])

  return (
    <PageShell title={item.label} description={item.description}>
      <div className="space-y-4">
        <Section
          title="Workspace"
          description="Identitas workspace ini dan paket yang sedang aktif."
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Nama" value={workspace.name} />
            <Field label="Slug" value={workspace.slug} />
            <Field
              label="Paket"
              value={PLAN_LABELS[workspace.plan] ?? workspace.plan}
            />
            <Field label="Produk terdaftar" value={formatNumber(productCount)} />
          </dl>
        </Section>

        <Section
          title="Batas pengiriman"
          description="Diperiksa sebelum setiap pengiriman, bukan hanya saat kampanye disusun."
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <Field
              label="Email per hari"
              value={formatNumber(workspace.dailyEmailLimit)}
            />
            <Field
              label="WhatsApp per hari"
              value={formatNumber(workspace.dailyWaLimit)}
            />
            <Field label="Zona waktu" value={workspace.timezone} />
          </dl>
          <p className="text-muted-foreground/80 mt-4 text-xs">
            Zona waktu dipakai untuk jam tenang: pesan tidak dikirim di luar jam
            kerja waktu setempat prospek.
          </p>
        </Section>

        <Section
          title="Mode otonom"
          description="AI mengusulkan, manusia menyetujui, sistem menjalankan."
        >
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="font-medium">
              {workspace.autonomousMode ? 'Aktif' : 'Nonaktif'}
            </Badge>
            <p className="text-muted-foreground text-sm">
              Belum tersedia di MVP. Setiap pesan keluar tetap wajib disetujui
              manusia, apa pun nilai kolom ini.
            </p>
          </div>
        </Section>

        <Section
          title="Anggota tim"
          description={`${formatNumber(members.length)} orang punya akses ke workspace ini.`}
        >
          <ul className="divide-y">
            {members.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
              >
                <span className="min-w-0 truncate text-sm">
                  {member.email ?? `Pengguna ${member.userId.slice(0, 8)}`}
                  {member.userId === user.id ? (
                    <span className="text-muted-foreground"> · Anda</span>
                  ) : null}
                </span>
                <Badge variant="outline" className="shrink-0 font-medium">
                  {roleLabel(member.role)}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Integrasi"
          description="Akun Gmail dan WhatsApp yang tersambung ke workspace ini."
        >
          {integrations.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Belum ada integrasi yang tersambung.
            </p>
          ) : (
            <ul className="divide-y">
              {integrations.map((integration) => (
                <li
                  key={integration.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-sm font-medium">
                    {PROVIDER_LABELS[integration.provider] ?? integration.provider}
                  </span>
                  <IntegrationStatusBadge status={integration.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Daftar suppression"
          description="Alamat dan nomor yang tidak boleh dihubungi lagi."
        >
          {suppressions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Belum ada entri. Balasan bernada menolak akan menambah entri di
              sini secara otomatis.
            </p>
          ) : (
            <ul className="divide-y">
              {suppressions.map((suppression) => (
                <li key={suppression.id} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {suppression.value}
                    </span>
                    <Badge variant="outline" className="shrink-0 font-medium">
                      {SUPPRESSION_KIND_LABELS[suppression.kind] ?? suppression.kind}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {suppression.reason ?? 'Tanpa keterangan'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <p className="text-muted-foreground/80 mt-6 text-xs">
        Layar ini masih baca-saja. Mengubah pengaturan, mengundang anggota, dan
        menyambungkan integrasi menyusul di slice berikutnya. Dibuat{' '}
        {formatDate(workspace.createdAt)}.
      </p>
    </PageShell>
  )
}
