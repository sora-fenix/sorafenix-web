import { navItem, type NavSegment } from '@/components/layout/nav-items'
import { EmptyState, PageShell } from '@/components/layout/page-shell'

type ModulePlaceholderProps = {
  segment: NavSegment
  emptyTitle: string
  emptyDescription: string
  /** What has to be built before this screen has real data. */
  hint: string
}

/**
 * Scaffold-phase page body. Each module replaces this with its real screen in
 * its own vertical slice; the heading and description keep coming from
 * nav-items.ts so the sidebar and the page can never drift apart.
 */
export function ModulePlaceholder({
  segment,
  emptyTitle,
  emptyDescription,
  hint,
}: ModulePlaceholderProps) {
  const item = navItem(segment)

  return (
    <PageShell title={item.label} description={item.description}>
      <EmptyState
        icon={item.icon}
        title={emptyTitle}
        description={emptyDescription}
        hint={hint}
      />
    </PageShell>
  )
}
