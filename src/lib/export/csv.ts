/**
 * CSV for Excel with an Indonesian locale.
 *
 * "Just join with commas" produces a file that opens wrong on the machines this
 * product is for, so three decisions are made deliberately here and each one is
 * pinned by a test:
 *
 *   1. **Semicolon separator.** Excel splits a CSV on the list separator of the
 *      system locale, which in Indonesia is `;`. A comma-separated file opens with
 *      every row crammed into column A.
 *   2. **Decimal comma.** For the same locale, `4.7` is text and `4,7` is the
 *      number four point seven. Rating is the only decimal we export, and it
 *      should be sortable.
 *   3. **A UTF-8 BOM.** Without it Excel reads the file as the legacy code page
 *      and every `é`, `—` and emoji in a shop name turns to mojibake.
 *
 * The cost of 1 and 2 is that the file is tuned for one locale rather than being
 * neutral, and a parser expecting RFC 4180 commas needs telling. That trade is
 * made on purpose: the file exists to be opened by a salesperson in Excel, not to
 * be re-imported by us. If a machine-readable export is ever needed, it should be
 * a different endpoint with plain commas and dots, not a compromise between them.
 *
 * Pure and import-free — the unit suite owns every rule above.
 */

export const CSV_DELIMITER = ';'
/** Excel needs CRLF to end rows reliably; every other reader accepts it. */
export const CSV_NEWLINE = '\r\n'
export const CSV_BOM = '﻿'

/**
 * A cell, in the two forms a spreadsheet distinguishes.
 *
 * `text` is quoted and escaped. `formula` is written verbatim, which only the
 * phone helper below produces — see `phoneCell` for why that is worth the risk.
 */
export type CsvCell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'formula'; readonly value: string }

export type CsvColumn<T> = {
  readonly header: string
  readonly cell: (row: T) => CsvCell
}

/**
 * Characters that make Excel and Sheets treat a cell as a formula rather than as
 * the text it is. A shop literally named `=Petshop` is not an attack, but a cell
 * beginning `=HYPERLINK(...)` in an exported file is the well-known CSV injection
 * path, and the file we hand a salesperson must not be able to run anything.
 *
 * Tab and CR are not listed: `textCell` trims first, so a cell can never still
 * begin with one by the time this runs. `"\t=SUM(A1)"` trims to `"=SUM(A1)"` and
 * is caught on its `=`.
 */
const FORMULA_LEAD = /^[=+\-@]/

/** Exactly what `textCell` produces from `FORMULA_LEAD`, and nothing wider. */
const ESCAPED_FORMULA_LEAD = /^'([=+\-@])/

/** Phone numbers we are willing to write as a formula: digits and separators only. */
const SAFE_PHONE = /^\+?[\d][\d\s()-]{4,24}$/

export function textCell(value: string | null | undefined): CsvCell {
  const text = value === null || value === undefined ? '' : String(value).trim()
  // A leading apostrophe is how a spreadsheet is told "this is text". It survives
  // into the cell as a marker rather than as content in both Excel and Sheets.
  return { kind: 'text', value: FORMULA_LEAD.test(text) ? `'${text}` : text }
}

/**
 * The inverse of the apostrophe `textCell` adds, so a re-uploaded export gets its
 * company names back.
 *
 * As narrow as the writer is wide: only a leading `'` immediately followed by one
 * of the four `FORMULA_LEAD` characters. `@home Cafe` exports as `'@home Cafe`
 * and must come back as `@home Cafe`, or that apostrophe becomes part of
 * `companies.name` — the string the Prospek screen shows, the export writes
 * again, and the draft generator addresses the customer by.
 *
 * A name that genuinely opens with `'@` is indistinguishable from an escaped one
 * and loses its apostrophe. That is the accepted cost of the pair being exact
 * inverses; the alternative is every escaped name accumulating one apostrophe per
 * round trip.
 */
export function unescapeTextCell(value: string): string {
  return value.replace(ESCAPED_FORMULA_LEAD, '$1')
}

export function numberCell(value: number | null | undefined): CsvCell {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { kind: 'text', value: '' }
  }
  // Decimal comma, no thousands separator — a separator would itself need
  // escaping and Excel parses the bare digits fine.
  return { kind: 'text', value: String(value).replace('.', ',') }
}

/**
 * A phone number that survives the trip.
 *
 * `+6281234567890` typed into Excel is read as a formula — unary plus — and comes
 * back as the number 6281234567890, which then renders as 6.28E+12. Writing
 * `="+6281234567890"` makes both Excel and Sheets evaluate a string literal, so
 * the cell shows the number as written and stays text.
 *
 * Anything that is not plainly a phone number falls back to a normal text cell,
 * so this can never be a way to smuggle a real formula into the file.
 */
export function phoneCell(value: string | null | undefined): CsvCell {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (text === '') return { kind: 'text', value: '' }
  if (!SAFE_PHONE.test(text)) return textCell(text)
  return { kind: 'formula', value: `="${text}"` }
}

/**
 * The inverse of `phoneCell`, so a file we exported can be uploaded back.
 *
 * It lives here rather than in the importer because it has to match `phoneCell`
 * character for character: same wrapper, same `SAFE_PHONE`. Two copies of that
 * pair in two files drift, and the drift shows up as a phone number silently
 * imported as the literal text `="+62812…"`.
 *
 * Takes a field that was **not** quoted in the file — that is the only way the
 * writer emits a formula. Anything else returns null and stays the text it is.
 */
export function unwrapPhoneCell(raw: string): string | null {
  const match = /^="([^"]*)"$/.exec(raw)
  if (match === null) return null
  const inner = match[1] ?? ''
  return SAFE_PHONE.test(inner) ? inner : null
}

export function dateCell(value: Date | null | undefined, timeZone = 'Asia/Jakarta'): CsvCell {
  if (value === null || value === undefined || Number.isNaN(value.getTime())) {
    return { kind: 'text', value: '' }
  }
  // en-CA gives YYYY-MM-DD, which sorts as text and is unambiguous in a column
  // a spreadsheet may or may not decide to parse as a date.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
  return { kind: 'text', value: formatted }
}

/** RFC 4180 quoting, applied to every text cell rather than only when needed. */
function renderCell(cell: CsvCell): string {
  if (cell.kind === 'formula') return cell.value
  return `"${cell.value.replace(/"/g, '""')}"`
}

export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: Iterable<T>): string {
  const lines: string[] = [
    columns.map((column) => renderCell(textCell(column.header))).join(CSV_DELIMITER),
  ]

  for (const row of rows) {
    lines.push(columns.map((column) => renderCell(column.cell(row))).join(CSV_DELIMITER))
  }

  // Trailing newline: a file whose last row has no terminator makes some tools
  // drop or merge it.
  return CSV_BOM + lines.join(CSV_NEWLINE) + CSV_NEWLINE
}

/**
 * A filename a download dialog can use. ASCII only and no path separators, so it
 * needs no RFC 5987 encoding and cannot escape the directory it lands in.
 */
export function csvFilename(prefix: string, at: Date): string {
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(at)
    .replace(/-/g, '')

  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${safePrefix === '' ? 'export' : safePrefix}-${stamp}.csv`
}
