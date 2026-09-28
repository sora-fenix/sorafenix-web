import { CSV_BOM, unescapeTextCell, unwrapPhoneCell } from '@/lib/export/csv'
import { type Result, err, ok } from '@/lib/types/result'

import type { RawLead } from './dedupe'
import { MAX_CSV_UPLOAD_BYTES, MAX_INGEST_ITEMS } from './limits'

/**
 * Reads the CSV a salesperson uploads. Pure: bytes in, rows or a reason out.
 *
 * Hand-written, and deliberately the mirror of `src/lib/export/csv.ts` rather
 * than a general RFC 4180 reader. The file this has to accept first is the one we
 * ourselves produce — BOM, semicolons, decimal commas, `="+62…"` phone cells —
 * and a salesperson's workflow is "download the list, fix it in Excel, upload it
 * back". A reader that cannot re-read our own export turns that loop into a
 * support ticket.
 *
 * It is also forgiving in the two directions Excel is unpredictable in: the
 * delimiter is detected rather than assumed, because saving as "CSV UTF-8" on a
 * machine set to English writes commas; and unknown columns are ignored, because
 * our export writes `Skor`, `Tahap` and `Alasan Skor`, which are ours to compute
 * and not ours to read back.
 *
 * Nothing here decides whether a row is a lead. That is `rejectionFor` in
 * `ingest.ts`, and it must stay the single definition for both intake paths.
 */

export type CsvImportError =
  | 'empty_file'
  | 'file_too_large'
  | 'not_utf8'
  | 'header_missing'
  | 'no_rows'
  | 'too_many_rows'
  | 'too_many_fields'
  | 'unterminated_quote'

export type CsvLeadRow = {
  /**
   * 1-based line in the uploaded file where this record starts.
   *
   * Not derivable from the row's position: a quoted address can span lines, so
   * row 12 and line 12 part company as soon as one does. This is the number the
   * rejection report shows, and it has to point at what the user sees in Excel.
   */
  line: number
  lead: RawLead
}

// -----------------------------------------------------------------------------
// Header mapping
// -----------------------------------------------------------------------------

type LeadField =
  | 'companyName'
  | 'website'
  | 'city'
  | 'address'
  | 'phone'
  | 'whatsapp'
  | 'email'
  | 'category'
  | 'sourceUrl'
  | 'rating'
  | 'reviewCount'

/**
 * The Bahasa Indonesia headers `src/lib/export/leads-csv.ts` writes, matched
 * case-insensitively after trimming.
 *
 * `Sumber` maps to `sourceUrl` because that is the column the exporter puts
 * `companies.source_url` under. The ingestion source of an uploaded file is
 * always `csv` and is never taken from the file itself — a row cannot assert
 * where it came from.
 */
const HEADER_FIELDS: Readonly<Record<string, LeadField>> = {
  'nama usaha': 'companyName',
  'kategori usaha': 'category',
  alamat: 'address',
  kota: 'city',
  rating: 'rating',
  'jumlah review': 'reviewCount',
  website: 'website',
  email: 'email',
  telepon: 'phone',
  whatsapp: 'whatsapp',
  sumber: 'sourceUrl',
}

// -----------------------------------------------------------------------------
// The reader
// -----------------------------------------------------------------------------

/**
 * One field, plus whether it arrived quoted.
 *
 * The flag is not bookkeeping: `phoneCell` writes its formula **unquoted**, so
 * "was this quoted" is the only thing distinguishing a phone cell from a text
 * cell whose contents happen to read `="+62…"`. Without it the reader would have
 * to guess, and guessing is how a shop named `="+62"` loses its name.
 */
type Field = { value: string; quoted: boolean }

type CsvRecord = { line: number; fields: Field[] }

/**
 * The most columns one record may have. The export writes eighteen.
 *
 * A bound rather than a preference: without it, 5 MB of `;` on a single line
 * builds five million field objects — 321 MB of heap for a file that carries no
 * data at all. A sheet with more than 512 columns is not a lead list.
 */
const MAX_FIELDS_PER_RECORD = 512

/**
 * How parsing ended.
 *
 * The caps are part of the parse rather than a filter applied to its result,
 * which is the whole point: `MAX_INGEST_ITEMS` downstream of a completed parse
 * cannot stop the allocation it is meant to bound. Measured before the change: a
 * 1 MB file of newlines reached 345 MB of heap and was then rejected for having
 * no rows, so three concurrent uploads could exhaust a 1 GB instance and take
 * every tenant on it down with them. The bail-outs below are what make the caps
 * mean something.
 */
type ParseOutcome =
  | { kind: 'ok'; records: CsvRecord[] }
  | { kind: 'too_many_rows' }
  | { kind: 'too_many_fields' }
  | { kind: 'unterminated_quote' }

/**
 * Counts separators in the header line only, outside quotes.
 *
 * `;` wins a tie, including the tie at zero: that is what we export, and a
 * one-column file is read the same way either way.
 */
export function detectDelimiter(text: string): string {
  let inQuotes = false
  let semicolons = 0
  let commas = 0

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (inQuotes) {
      if (ch !== '"') continue
      if (text.charAt(i + 1) === '"') {
        i += 1
        continue
      }
      inQuotes = false
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === '\n' || ch === '\r') break
    if (ch === ';') semicolons += 1
    else if (ch === ',') commas += 1
  }

  return commas > semicolons ? ',' : ';'
}

/**
 * @param maxRecords stop once this many records exist, header included. The
 * caller passes one more than it can accept, so a full array means "too many"
 * without the parser needing to know what a header is.
 */
function parseRecords(text: string, delimiter: string, maxRecords: number): ParseOutcome {
  const records: CsvRecord[] = []
  let fields: Field[] = []
  let value = ''
  let quoted = false
  let inQuotes = false
  let line = 1
  let recordLine = 1
  let i = 0
  let overflow: 'rows' | 'fields' | null = null

  const endField = (): void => {
    if (fields.length >= MAX_FIELDS_PER_RECORD) {
      overflow = 'fields'
      return
    }
    fields.push({ value, quoted })
    value = ''
    quoted = false
  }

  const endRecord = (): void => {
    endField()
    if (overflow !== null) return

    // Blank lines are dropped here rather than filtered afterwards. A file of
    // nothing but newlines must not retain one record object per line, and the
    // array is reused so a blank line costs no allocation at all.
    if (fields.some((field) => field.value.trim() !== '')) {
      records.push({ line: recordLine, fields })
      fields = []
      if (records.length >= maxRecords) overflow = 'rows'
    } else {
      fields.length = 0
    }
    recordLine = line
  }

  while (i < text.length && overflow === null) {
    const ch = text.charAt(i)

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a single one closes the field.
        if (text.charAt(i + 1) === '"') {
          value += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      // A newline inside quotes is content, but it still moves the line counter:
      // the report has to name the line the user sees, not the record's index.
      if (ch === '\r') {
        value += '\n'
        line += 1
        i += text.charAt(i + 1) === '\n' ? 2 : 1
        continue
      }
      if (ch === '\n') line += 1
      value += ch
      i += 1
      continue
    }

    // Only a quote at the very start of a field opens one. Mid-field it is text.
    if (ch === '"' && value === '') {
      inQuotes = true
      quoted = true
      i += 1
      continue
    }
    if (ch === delimiter) {
      endField()
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      line += 1
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1
      endRecord()
      continue
    }

    value += ch
    i += 1
  }

  if (overflow === 'fields') return { kind: 'too_many_fields' }
  if (overflow === 'rows') return { kind: 'too_many_rows' }

  // An unterminated quote is a file-level error, not a row.
  //
  // Treating it as a complete record is how `"Toko A;08123456789` followed by two
  // more lines becomes ONE accepted lead whose `companyName` is all three lines —
  // two leads silently gone, and three customers' phone numbers written into
  // `companies.name`, which the Prospek screen shows, the export re-emits and the
  // draft generator addresses the customer by. The privacy promise is not only
  // about what the rejection report says; it is about what an accepted row holds.
  if (inQuotes) return { kind: 'unterminated_quote' }

  // A file ending without a terminator still has a last record; one ending with
  // a terminator does not, and must not gain a phantom blank row.
  if (value !== '' || quoted || fields.length > 0) endRecord()
  if (overflow === 'fields') return { kind: 'too_many_fields' }
  if (overflow === 'rows') return { kind: 'too_many_rows' }

  return { kind: 'ok', records }
}

// -----------------------------------------------------------------------------
// Cell readers
// -----------------------------------------------------------------------------

function readText(record: CsvRecord, index: number | undefined): string | null {
  if (index === undefined) return null
  const field = record.fields[index]
  if (field === undefined) return null

  const raw = field.value.trim()
  // An unquoted field is the only place the writer emits a formula, so the phone
  // unwrap is tried there and nowhere else. Anything that is not a phone cell may
  // still be a text cell the writer escaped, so the other inverse runs after.
  const unwrapped = field.quoted ? null : unwrapPhoneCell(raw)
  const text = unwrapped ?? unescapeTextCell(raw)
  return text === '' ? null : text
}

/** `1.234` and `12.345.678`: dot-grouped thousands, no decimal part. */
const GROUPED_THOUSANDS = /^[+-]?\d{1,3}(?:\.\d{3})+$/

/**
 * A number written the way the exporter writes it, and the way an Indonesian
 * Excel writes it: `4,7`, `1.234,5`, and `1.234` once a sheet has applied its own
 * thousands separator to a review count.
 *
 * The dot is ambiguous and is resolved by shape, not by guessing:
 *
 *   - a comma anywhere means the dots are thousands separators — `1.234,5` → 1234.5
 *   - no comma, but dots grouping digits in threes, means the same — `1.234` → 1234
 *   - otherwise the dot is a decimal point — `4.7` → 4.7, for a file that has been
 *     through a machine set to English
 *
 * The second case is why this is not simply "dot is a decimal point": a review
 * count of `1.234` read as 1.234 is not an integer, so `normalizeReviewCount`
 * drops it and the column disappears without a word. `4.7` cannot be confused
 * with it — `.7` is one digit, not three.
 *
 * Anything that is not a number at all becomes null; a typo in one cell must not
 * cost the row.
 */
export function parseIndonesianNumber(input: string | null): number | null {
  if (input === null) return null

  const text = input.trim()
  if (text === '') return null

  const normalized =
    text.includes(',') || GROUPED_THOUSANDS.test(text)
      ? text.replace(/\./g, '').replace(',', '.')
      : text

  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null

  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

function readNumber(record: CsvRecord, index: number | undefined): number | null {
  return parseIndonesianNumber(readText(record, index))
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

function decode(bytes: Uint8Array): Result<string, CsvImportError> {
  try {
    // `fatal` on purpose: a Latin-1 export would otherwise decode into replacement
    // characters and be stored as a company name nobody can search for.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return ok(text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text)
  } catch {
    return err('not_utf8')
  }
}

export function parseLeadsCsv(bytes: Uint8Array): Result<CsvLeadRow[], CsvImportError> {
  if (bytes.byteLength === 0) return err('empty_file')
  if (bytes.byteLength > MAX_CSV_UPLOAD_BYTES) return err('file_too_large')

  const decoded = decode(bytes)
  if (!decoded.ok) return decoded

  const text = decoded.value
  if (text.trim() === '') return err('empty_file')

  const delimiter = detectDelimiter(text)
  // One more than we can accept, so a full array is itself the overflow signal:
  // the header, the cap, and the row that proves the cap was exceeded.
  const outcome = parseRecords(text, delimiter, MAX_INGEST_ITEMS + 2)
  if (outcome.kind !== 'ok') return err(outcome.kind)

  const header = outcome.records[0]
  if (header === undefined) return err('no_rows')

  // First occurrence wins: a sheet with two `Telepon` columns is a mistake, and
  // reading the left one matches what a person sees when they scroll right.
  const columns = new Map<LeadField, number>()
  header.fields.forEach((field, index) => {
    const key = field.value.trim().toLowerCase()
    const target = HEADER_FIELDS[key]
    if (target !== undefined && !columns.has(target)) columns.set(target, index)
  })

  const nameColumn = columns.get('companyName')
  if (nameColumn === undefined) return err('header_missing')

  // Blank records were dropped during the parse, so this is already the data.
  const dataRecords = outcome.records.slice(1)
  if (dataRecords.length === 0) return err('no_rows')

  const rows = dataRecords.map((record) => ({
    line: record.line,
    lead: {
      // Empty is carried through rather than dropped, so `rejectionFor` reports
      // `company_name_missing` against a line the user can find.
      companyName: readText(record, nameColumn) ?? '',
      website: readText(record, columns.get('website')),
      city: readText(record, columns.get('city')),
      address: readText(record, columns.get('address')),
      phone: readText(record, columns.get('phone')),
      whatsapp: readText(record, columns.get('whatsapp')),
      email: readText(record, columns.get('email')),
      category: readText(record, columns.get('category')),
      sourceUrl: readText(record, columns.get('sourceUrl')),
      // Range and integer-ness are decided once, in `normalizeLead`.
      rating: readNumber(record, columns.get('rating')),
      reviewCount: readNumber(record, columns.get('reviewCount')),
    } satisfies RawLead,
  }))

  return ok(rows)
}
