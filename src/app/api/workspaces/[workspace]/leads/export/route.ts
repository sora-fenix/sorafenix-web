import { NextResponse } from 'next/server'

import { getWorkspaceContext } from '@/lib/auth/session'
import { exportLeads } from '@/lib/db/queries/records'
import { csvFilename } from '@/lib/export/csv'
import { leadsToCsv } from '@/lib/export/leads-csv'

/**
 * `GET /api/workspaces/{slug}/leads/export` — every lead in the workspace, as CSV.
 *
 * This is a door out of the building: it hands a person a file containing every
 * business name, phone number and WhatsApp number the workspace holds. So the
 * workspace is resolved through `getWorkspaceContext`, which requires a signed-in
 * user AND a membership row, and the slug in the URL is never trusted to identify
 * the workspace on its own.
 *
 * A non-member gets the same 404 as a slug that does not exist. Distinguishing
 * them would let anyone enumerate which workspaces are real.
 *
 * The response is Bahasa Indonesia where a human reads it, English machine codes
 * where a client does — same split as the n8n webhook.
 */

// `getWorkspaceContext` reads Supabase auth cookies, which need the Node runtime.
export const runtime = 'nodejs'
/** Never cached or prerendered: the content is per-user and per-workspace. */
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ workspace: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { workspace: slug } = await context.params

  const workspaceContext = await getWorkspaceContext(slug)
  if (workspaceContext === null) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const rows = await exportLeads(workspaceContext.workspace.id)
  const csv = leadsToCsv(rows)
  const filename = csvFilename(`prospek-${workspaceContext.workspace.slug}`, new Date())

  return new NextResponse(csv, {
    status: 200,
    headers: {
      // charset matters as much as the BOM: without it some browsers hand the
      // file to Excel as the system code page and the BOM is the only defence.
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // A lead list is stale the moment scoring runs again, and it is per-user.
      'cache-control': 'no-store',
    },
  })
}
