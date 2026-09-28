import 'server-only'

import { and, eq } from 'drizzle-orm'

import { db, schema } from '@/lib/db/drizzle'
import { type Result, err, ok } from '@/lib/types/result'

import { type CsvImportError, parseLeadsCsv } from './csv-import'
import { type IngestItem, type RejectionReason, ingestLeads } from './ingest'

/**
 * The upload path into lead ingestion (SPEC §2, "Also accept CSV upload through
 * the UI hitting the same pipeline").
 *
 * A second mouth on `ingestLeads`, not a second stomach. Dedupe, the merge rules,
 * the inserts and the `activities` rows all stay where the webhook left them; all
 * this adds is parsing, a workspace check and a translation of row indexes back
 * into line numbers.
 *
 * **Privacy is the design constraint here, not a footnote.** A CSV a salesperson
 * uploads is a list of real businesses and real numbers, so:
 *
 *   - no `webhook_events` row. Its `payload` column holds the whole batch, which
 *     would be a second, longer-lived copy of the contact data sitting outside
 *     `companies` where no deletion path looks for it. There is nothing to be
 *     idempotent against anyway: the browser posts once, and a re-upload of the
 *     same file is already a no-op because dedupe catches every row.
 *   - nothing is written to disk or to Storage. The bytes live in memory for the
 *     length of one request.
 *   - no row content in any log, any error, or any rejection. A rejected row is
 *     a line number and a reason code. `IngestItem.raw` is the one place the row
 *     lands, and it lands in `companies.raw` — the same column, under the same
 *     deletion path, as the webhook's copy.
 */

export type CsvUploadError = CsvImportError | 'campaign_not_found' | 'db_error'

export type CsvRejection = {
  /** 1-based line in the uploaded file. Never the line's contents. */
  line: number
  reason: RejectionReason
}

export type CsvUploadResult = {
  accepted: number
  inserted: number
  duplicates: number
  rejected: CsvRejection[]
}

export type CsvUploadInput = {
  workspaceId: string
  campaignId: string
  bytes: Uint8Array
}

/** Every intake path writes this, so a lead's origin is never in doubt. */
const SOURCE = 'csv'

export async function importLeadsFromCsv(
  input: CsvUploadInput,
): Promise<Result<CsvUploadResult, CsvUploadError>> {
  const parsed = parseLeadsCsv(input.bytes)
  if (!parsed.ok) return parsed

  // The campaign is re-read scoped to the workspace rather than trusted from the
  // caller: the Drizzle handle bypasses RLS, so this query is the only thing
  // stopping a campaign id from another tenant being written into this one.
  const [campaign] = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.workspaceId, input.workspaceId),
        eq(schema.campaigns.id, input.campaignId),
      ),
    )
    .limit(1)

  if (campaign === undefined) return err('campaign_not_found')

  const items: IngestItem[] = parsed.value.map((row) => ({
    ...row.lead,
    raw: row.lead,
  }))

  try {
    const result = await db.transaction((tx) =>
      ingestLeads(tx, {
        workspaceId: input.workspaceId,
        campaignId: campaign.id,
        source: SOURCE,
        items,
      }),
    )

    return ok({
      accepted: result.accepted,
      inserted: result.inserted,
      duplicates: result.duplicates,
      rejected: result.rejected.map((rejection) => ({
        // `ingestLeads` counts items; the user counts lines in Excel. The two
        // differ the moment one address is quoted across two lines.
        line: parsed.value[rejection.index]?.line ?? rejection.index + 2,
        reason: rejection.reason,
      })),
    })
  } catch (error) {
    // The name only. A Postgres error message can quote the offending value, and
    // the value is a customer's phone number.
    console.error('[csv-upload] ingest failed:', error instanceof Error ? error.name : 'unknown')
    return err('db_error')
  }
}
