import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { refreshSession } from '@/lib/db/middleware'

/**
 * Guards everything under /app. Membership in the specific workspace is checked
 * in app/app/[workspace]/layout.tsx — the middleware only answers "is anyone
 * signed in?", because it has no database access at the edge.
 */
export async function middleware(request: NextRequest) {
  const { response, userId } = await refreshSession(request)

  if (userId === null) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)

    const redirect = NextResponse.redirect(loginUrl)
    // Carry over any refreshed auth cookies so the redirect does not drop them.
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie)
    }
    return redirect
  }

  return response
}

export const config = {
  matcher: ['/app/:path*'],
}
