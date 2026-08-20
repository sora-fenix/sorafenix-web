import { createServerClient } from '@supabase/ssr'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { publicEnv } from '@/lib/env'

export type SessionRefresh = {
  /** Response carrying any refreshed auth cookies. Must be the one returned. */
  response: NextResponse
  /** Authenticated user id, or null when there is no valid session. */
  userId: string | null
}

/**
 * Refreshes the Supabase session on every matched request and reports whether a
 * user is signed in. Cookie writes have to land on the response object that is
 * actually returned, which is why the caller gets it back rather than making
 * its own.
 */
export async function refreshSession(request: NextRequest): Promise<SessionRefresh> {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // getUser() revalidates the token with Supabase. Do not swap this for
  // getSession(), which trusts whatever is in the cookie.
  const { data, error } = await supabase.auth.getUser()

  return {
    response,
    userId: error !== null || data.user === null ? null : data.user.id,
  }
}
