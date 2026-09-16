import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { formatNumber } from '@/lib/format'
import { type Page, pageHref } from '@/lib/pagination'
import { cn } from '@/lib/utils'

/**
 * Previous / next paging for the list screens.
 *
 * A server component with plain links, not buttons: paging is a navigation, so
 * it belongs in the URL. That makes a page shareable, survives a refresh, and
 * keeps the whole screen a server component — nothing here needs `'use client'`
 * (`.claude/rules/ui.md`).
 *
 * The counts are the point of the thing. Before this existed the leads screen
 * fetched 100 rows out of 1208 and captioned itself "100 prospek", which is not a
 * truncation a reader can detect.
 */

type PaginationProps<T> = {
  readonly page: Page<T>
  /** The screen's own path, e.g. `/app/acme/leads`. */
  readonly basePath: string
  /** What is being counted, lower case: "prospek", "perusahaan". */
  readonly noun: string
}

export function Pagination<T>({ page, basePath, noun }: PaginationProps<T>) {
  const summary =
    page.total === 0
      ? `Belum ada ${noun}.`
      : `Menampilkan ${formatNumber(page.from)}–${formatNumber(page.to)} dari ${formatNumber(page.total)} ${noun}.`

  // One page of results needs the total stated, but not the controls.
  if (page.totalPages <= 1) {
    return <p className="text-muted-foreground mt-3 text-sm">{summary}</p>
  }

  return (
    <nav
      aria-label="Navigasi halaman"
      className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-muted-foreground text-sm">
        {summary}{' '}
        <span className="whitespace-nowrap">
          Halaman {formatNumber(page.page)} dari {formatNumber(page.totalPages)}.
        </span>
      </p>

      <div className="flex items-center gap-2">
        <PageLink
          href={pageHref(basePath, page.page - 1)}
          enabled={page.hasPrevious}
          label="Sebelumnya"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Sebelumnya
        </PageLink>
        <PageLink
          href={pageHref(basePath, page.page + 1)}
          enabled={page.hasNext}
          label="Berikutnya"
        >
          Berikutnya
          <ChevronRight className="size-4" aria-hidden />
        </PageLink>
      </div>
    </nav>
  )
}

type PageLinkProps = {
  readonly href: string
  readonly enabled: boolean
  readonly label: string
  readonly children: React.ReactNode
}

/**
 * At the ends of the range the control becomes a `span`, not a disabled link.
 *
 * A link that goes nowhere is still focusable and still clickable with a
 * keyboard; removing the anchor is the only way to actually take it out of the
 * tab order.
 */
function PageLink({ href, enabled, label, children }: PageLinkProps) {
  const className = cn(
    buttonVariants({ variant: 'outline', size: 'sm' }),
    'gap-1',
    enabled ? '' : 'pointer-events-none opacity-50',
  )

  if (!enabled) {
    return (
      <span className={className} aria-disabled="true">
        {children}
      </span>
    )
  }

  return (
    <Link href={href} className={className} aria-label={label} rel={label === 'Sebelumnya' ? 'prev' : 'next'}>
      {children}
    </Link>
  )
}
