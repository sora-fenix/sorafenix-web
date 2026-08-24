import { Skeleton } from '@/components/ui/skeleton'

export default function WorkspaceLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-full max-w-md" />
      <Skeleton className="mt-6 h-56 w-full rounded-xl" />
      <span className="sr-only">Memuat…</span>
    </div>
  )
}
