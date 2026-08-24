import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type PageShellProps = {
  title: string
  description: string
  children: ReactNode
}

export function PageShell({ title, description, children }: PageShellProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{description}</p>
      </div>
      {children}
    </div>
  )
}

type EmptyStateProps = {
  icon: LucideIcon
  title: string
  description: string
  hint?: string
}

/**
 * Every module screen ships this until its slice is built, so the app is
 * demo-able end to end and the empty state is designed rather than an
 * afterthought.
 */
export function EmptyState({ icon: Icon, title, description, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center">
      <div className="bg-muted text-muted-foreground mb-4 flex size-11 items-center justify-center rounded-full">
        <Icon className="size-5" />
      </div>
      <h2 className="text-base font-medium">{title}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-md text-sm">{description}</p>
      {hint === undefined ? null : (
        <p className="text-muted-foreground/80 mt-4 max-w-md text-xs">{hint}</p>
      )}
    </div>
  )
}
