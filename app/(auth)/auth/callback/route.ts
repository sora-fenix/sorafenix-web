import { NextResponse, type NextRequest } from 'next/server'

import { createSupabaseServerClient } from '@/lib/db/server'

/**
 * Magic-link landing point. Supabase redirects here with a one-time `code`,
 * which we exchange for a session cookie before forwarding the user on.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const nextParam = searchParams.get('next')

  // Relative paths only — an absolute ?next= would be an open redirect.
  const next =
    nextParam !== null && nextParam.startsWith('/') && !nextParam.startsWith('//')
      ? nextParam
      : '/app'

  if (code === null) {
    return NextResponse.redirect(new URL('/auth/error?reason=missing_code', origin))
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error !== null) {
    console.error('exchangeCodeForSession failed', error)
    return NextResponse.redirect(new URL('/auth/error?reason=invalid_code', origin))
  }

  return NextResponse.redirect(new URL(next, origin))
}
