import { createBrowserClient } from '@supabase/ssr'

import { publicEnv } from '@/lib/env'

/**
 * Supabase client for client components. Uses the anon key, so every query it
 * makes is subject to Row Level Security.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}
