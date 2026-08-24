/**
 * Next.js boot hook. Runs once when the server starts, before any request is
 * handled — which is what makes CLAUDE.md rule 1 ("crash at boot if a var is
 * missing") true rather than aspirational.
 */
export async function register(): Promise<void> {
  // NEXT_RUNTIME is injected by Next to tell the node and edge runtimes apart.
  // It is not application configuration, so it does not belong in lib/env.ts —
  // this is the one sanctioned direct read of process.env outside that file.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { serverEnv } = await import('@/lib/env')
  serverEnv()
}
