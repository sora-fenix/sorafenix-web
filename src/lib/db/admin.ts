import 'server-only'

import { createClient } from '@supabase/supabase-js'

import { publicEnv, serverEnv } from '@/lib/env'

/**
 * Service-role Supabase client. BYPASSES ROW LEVEL SECURITY.
 *
 * CLAUDE.md rule 6: the service-role key is used ONLY inside this file. This
 * module may never be imported from a client component or an unauthenticated
 * route. The `server-only` import above turns a violation into a build error
 * rather than a leaked key.
 *
 * Legitimate uses: webhook handlers that have already verified an HMAC
 * signature, cron jobs, and workspace provisioning. Nothing else.
 */
export function createSupabaseAdminClient() {
  return createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
