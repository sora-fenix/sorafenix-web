import { AlertTriangle } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import {
  ACTIVITY_TYPE_LABELS,
  ACTOR_LABELS,
  CategoryBadge,
  LeadStatusBadge,
} from '@/components/crm/labels'
import { IntakeSparkline } from '@/components/crm/intake-sparkline'
import { navItem } from '@/components/layout/nav-items'
import { PageShell } from '@/components/layout/page-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getWorkspaceContext } from '@/lib/auth/session'
import {
  getDailyIntake,
  getDashboardStats,
  getDueLeads,
  getFunnel,
  getPendingApprovalCount,
  getRecentActivities,
} from '@/lib/db/queries/dashboard'
import {
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelativeDay,
  isOverdue,
} from '@/lib/format'

export const metadata: Metadata = { title: navItem('dashboard').label }

type PageProps = { params: Promise<{ workspace: string }> }

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-muted-foreground text-xs font-medium">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint === undefined ? null : (
          <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>
        )}
      </CardContent>
    </Card>
  )
}

export default async function DashboardPage({ params }: PageProps) {
  const { workspace: slug } = await params
  const context = await getWorkspaceContext(slug)
  if (context === null) notFound()

  const workspaceId = context.workspace.id
  const [stats, funnel, dueLeads, activities, pendingApprovals, intake] = await Promise.all([
    getDashboardStats(workspaceId),
    getFunnel(workspaceId),
    getDueLeads(workspaceId),
    getRecentActivities(workspaceId),
    getPendingApprovalCount(workspaceId),
    getDailyIntake(workspaceId),
  ])

  const item = navItem('dashboard')
  const funnelMax = Math.max(...funnel.map((s) => s.count), 1)
  const intakeTotal = intake.reduce((sum, day) => sum + day.count, 0)

  return (
    <PageShell title={item.label} description={item.description}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Total Prospek" value={formatNumber(stats.totalLeads)} />
        <StatCard label="Terkualifikasi" value={formatNumber(stats.qualified)} />
        <StatCard label="Prospek Panas" value={formatNumber(stats.hot)} />
        <StatCard label="Email Terkirim" value={formatNumber(stats.emailsSent)} />
        <StatCard label="WhatsApp Terkirim" value={formatNumber(stats.waSent)} />
        <StatCard label="Balasan" value={formatNumber(stats.replies)} />
        <StatCard label="Meeting" value={formatNumber(stats.meetings)} />
        <StatCard
          label="Rasio Balasan"
          value={formatPercent(stats.replyRate)}
          hint={`${formatNumber(stats.replies)} dari ${formatNumber(stats.emailsSent + stats.waSent)} terkirim`}
        />
        <StatCard
          label="Rasio Konversi"
          value={formatPercent(stats.conversionRate)}
          hint="Prospek menang / total"
        />
        <StatCard
          label="Menunggu Persetujuan"
          value={formatNumber(pendingApprovals)}
          hint="Draf di antrean"
        />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold">Prospek Baru 7 Hari Terakhir</h2>
        <Card>
          <CardContent>
            {intakeTotal === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                Belum ada prospek baru minggu ini. Jalankan pencarian di n8n, atau
                cek apakah workflow-nya masih Active.
              </p>
            ) : (
              <>
                <div className="mb-4 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatNumber(intakeTotal)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    perusahaan unik, setelah duplikat digabung
                  </span>
                </div>
                <IntakeSparkline days={intake} />
              </>
            )}
          </CardContent>
        </Card>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold">Corong Penjualan</h2>
          <Card>
            <CardContent className="space-y-3">
              {funnel.map((stage) => (
                <div key={stage.key}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span>{stage.label}</span>
                    <span className="font-medium tabular-nums">
                      {formatNumber(stage.count)}
                    </span>
                  </div>
                  <div
                    className="bg-muted h-2 overflow-hidden rounded-full"
                    role="img"
                    aria-label={`${stage.label}: ${stage.count} prospek`}
                  >
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${Math.round((stage.count / funnelMax) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Antrean Hari Ini</h2>
          <Card>
            <CardContent>
              {dueLeads.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  Tidak ada tindak lanjut yang jatuh tempo hari ini.
                </p>
              ) : (
                <ul className="divide-y">
                  {dueLeads.map((lead) => (
                    <li key={lead.id} className="flex items-center gap-3 py-2.5 first:pt-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {lead.companyName ?? 'Tanpa nama'}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {lead.contactName ?? 'Kontak belum ada'}
                        </p>
                      </div>
                      <CategoryBadge category={lead.category} />
                      <span
                        className={
                          isOverdue(lead.nextActionAt)
                            ? 'text-destructive flex shrink-0 items-center gap-1 text-xs font-medium'
                            : 'text-muted-foreground shrink-0 text-xs'
                        }
                      >
                        {isOverdue(lead.nextActionAt) ? (
                          <AlertTriangle className="size-3" />
                        ) : null}
                        {formatRelativeDay(lead.nextActionAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold">Aktivitas Terakhir</h2>
        <Card>
          <CardContent>
            <ul className="divide-y">
              {activities.map((activity) => (
                <li
                  key={activity.id}
                  className="flex items-center gap-3 py-2.5 text-sm first:pt-0"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {ACTIVITY_TYPE_LABELS[activity.type] ?? activity.type}
                    {activity.companyName === null ? null : (
                      <span className="text-muted-foreground"> — {activity.companyName}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {ACTOR_LABELS[activity.actor] ?? activity.actor}
                  </span>
                  <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                    {formatDateTime(activity.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <p className="text-muted-foreground mt-6 text-xs">
        Semua angka dihitung di server. Prospek berstatus{' '}
        <LeadStatusBadge status="do_not_contact" /> tidak pernah masuk antrean kirim.
      </p>
    </PageShell>
  )
}
