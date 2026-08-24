import { NextResponse } from 'next/server'

/**
 * Liveness check. Deliberately does not touch the database — it answers
 * "is the app process up and did env validation pass?", nothing more.
 */
export function GET() {
  return NextResponse.json({ ok: true, service: 'sora' })
}
