import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { publicEnv } from '@/lib/env'

/**
 * Supabase client for server components, route handlers and server actions.
 * Anon key + the user's session cookie, so RLS applies as the signed-in user.
 *
 * For privileged work that must bypass RLS, use `lib/db/admin.ts` instead — and
 * think hard before you do.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Components cannot set cookies. The middleware refreshes the
            // session on every request, so this is safe to swallow.
          }
        },
      },
    },
  )
}
