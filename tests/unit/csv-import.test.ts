import { describe, expect, it } from 'vitest'

import {
  type CsvImportError,
  type CsvLeadRow,
  detectDelimiter,
  parseIndonesianNumber,
  parseLeadsCsv,
} from '@/lib/leads/csv-import'
import { MAX_CSV_UPLOAD_BYTES, MAX_INGEST_ITEMS } from '@/lib/leads/limits'
import { CSV_BOM } from '@/lib/export/csv'
import { leadsToCsv } from '@/lib/export/leads-csv'
import type { LeadExportRow } from '@/lib/db/queries/records'

/**
 * The reader has one job the export does not: it has to accept files a person
 * saved out of Excel, which means the delimiter, the newline, the decimal mark
 * and the encoding are all things we discover rather than things we chose.
 *
 * Every case below is a way an upload silently produces the wrong data instead of
 * an error — one column holding the whole row, a rating of 47, a phone number
 * stored as `="+62812…"`, an address truncated at its own comma — plus the
 * round-trip that the export/upload loop depends on.
 */

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function rowsOf(bytes: Uint8Array): CsvLeadRow[] {
  const result = parseLeadsCsv(bytes)
  if (!result.ok) throw new Error(`expected rows, got ${result.error}`)
  return result.value
}

function errorOf(bytes: Uint8Array): CsvImportError {
  const result = parseLeadsCsv(bytes)
  if (result.ok) throw new Error('expected a rejection, got rows')
  return result.error
}

function firstRow(bytes: Uint8Array): CsvLeadRow {
  const row = rowsOf(bytes)[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

// -----------------------------------------------------------------------------
// The delimiter
// -----------------------------------------------------------------------------

describe('the delimiter is detected, not assumed', () => {
  it('reads the semicolons our own export writes', () => {
    const row = firstRow(encode('Nama Usaha;Kota\r\nPet Shop Surabaya;Surabaya\r\n'))
    expect(row.lead.companyName).toBe('Pet Shop Surabaya')
    expect(row.lead.city).toBe('Surabaya')
  })

  it('reads commas, which is what Excel writes on an English machine', () => {
    const row = firstRow(encode('Nama Usaha,Kota\nPet Shop Surabaya,Surabaya\n'))
    expect(row.lead.companyName).toBe('Pet Shop Surabaya')
    expect(row.lead.city).toBe('Surabaya')
  })

  it('gives a tie to the semicolon, because that is what we export', () => {
    expect(detectDelimiter('Nama Usaha;Kota,Provinsi\n')).toBe(';')
  })

  it('ignores separators inside a quoted header cell', () => {
    // Two commas, but both are content. Counting them would split the file on
    // the wrong character and put the whole row in the first column.
    expect(detectDelimiter('"Nama Usaha";"Kota, Provinsi, Negara"\r\n')).toBe(';')
  })

  it('counts only the header line', () => {
    expect(detectDelimiter('Nama Usaha;Kota\r\nToko,A,B,C,D,E,F\r\n')).toBe(';')
  })
})

// -----------------------------------------------------------------------------
// The shape of a file Excel produces
// -----------------------------------------------------------------------------

describe('what a spreadsheet actually saves', () => {
  it('sees past a UTF-8 BOM on the first header', () => {
    const row = firstRow(encode(`${CSV_BOM}Nama Usaha;Kota\r\nToko Bahagia;Bandung\r\n`))
    expect(row.lead.companyName).toBe('Toko Bahagia')
  })

  it('accepts LF as well as CRLF', () => {
    expect(rowsOf(encode('Nama Usaha;Kota\nA;Bandung\nB;Bandung\n'))).toHaveLength(2)
    expect(rowsOf(encode('Nama Usaha;Kota\r\nA;Bandung\r\nB;Bandung\r\n'))).toHaveLength(2)
  })

  it('keeps a delimiter that sits inside a quoted field', () => {
    const row = firstRow(
      encode('Nama Usaha;Alamat\r\n"Toko A";"Jl. Mawar No. 5; RT 02; Bandung"\r\n'),
    )
    expect(row.lead.address).toBe('Jl. Mawar No. 5; RT 02; Bandung')
  })

  it('keeps a newline that sits inside a quoted field', () => {
    const rows = rowsOf(
      encode('Nama Usaha;Alamat\r\n"Toko A";"Jl. Mawar No. 5\r\nBandung"\r\n"Toko B";"Jl. Melati"\r\n'),
    )
    expect(rows[0]?.lead.address).toBe('Jl. Mawar No. 5\nBandung')
    expect(rows).toHaveLength(2)
  })

  it('counts the lines a person sees, not the rows a parser sees', () => {
    // The first record spans lines 2 and 3, so the second record starts at 4.
    // "Baris 4" has to point at the line Excel highlights.
    const rows = rowsOf(
      encode('Nama Usaha;Alamat\r\n"Toko A";"Jl. Mawar\r\nBandung"\r\n"Toko B";"Jl. Melati"\r\n'),
    )
    expect(rows.map((row) => row.line)).toEqual([2, 4])
  })

  it('unescapes a doubled quote', () => {
    const row = firstRow(encode('Nama Usaha\r\n"Toko ""Bahagia"" Sejahtera"\r\n'))
    expect(row.lead.companyName).toBe('Toko "Bahagia" Sejahtera')
  })

  it('skips blank lines rather than reporting them as rows', () => {
    expect(rowsOf(encode('Nama Usaha;Kota\r\nA;Bandung\r\n\r\nB;Bandung\r\n\r\n'))).toHaveLength(2)
  })

  it('tolerates a row with fewer columns than the header', () => {
    const row = firstRow(encode('Nama Usaha;Kota;Telepon\r\nToko A\r\n'))
    expect(row.lead.companyName).toBe('Toko A')
    expect(row.lead.city).toBeNull()
    expect(row.lead.phone).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Cells
// -----------------------------------------------------------------------------

describe('the Indonesian decimal comma', () => {
  it('reads 4,7 as four point seven', () => {
    const row = firstRow(encode('Nama Usaha;Rating\r\nToko A;"4,7"\r\n'))
    expect(row.lead.rating).toBe(4.7)
  })

  it('still reads 4.7, for a file that has been through an English machine', () => {
    expect(parseIndonesianNumber('4.7')).toBe(4.7)
  })

  it('treats the dot as a thousands separator when a comma is present', () => {
    expect(parseIndonesianNumber('1.234,5')).toBe(1234.5)
  })

  it('reads a dot-grouped review count as thousands, not as a decimal', () => {
    // `1.234` read as 1.234 is not an integer, so normalizeReviewCount drops it
    // and the column vanishes without a word. Three-digit grouping is the tell.
    expect(parseIndonesianNumber('1.234')).toBe(1234)
    expect(parseIndonesianNumber('12.345.678')).toBe(12345678)
    // Not grouping: one digit after the dot, so it is a rating.
    expect(parseIndonesianNumber('4.7')).toBe(4.7)
  })

  it('turns an unparseable number into null rather than rejecting the row', () => {
    const row = firstRow(encode('Nama Usaha;Rating;Jumlah Review\r\nToko A;"tidak ada";"-"\r\n'))
    expect(row.lead.companyName).toBe('Toko A')
    expect(row.lead.rating).toBeNull()
    expect(row.lead.reviewCount).toBeNull()
  })
})

describe('the phone cells our export writes', () => {
  it('unwraps ="+62…" back to the plain number', () => {
    const row = firstRow(encode('Nama Usaha;Telepon;WhatsApp\r\nToko A;="+628123456789";="+628123456789"\r\n'))
    expect(row.lead.phone).toBe('+628123456789')
    expect(row.lead.whatsapp).toBe('+628123456789')
  })

  it('leaves a quoted cell alone, because the writer never quotes a formula', () => {
    const row = firstRow(encode('Nama Usaha;Telepon\r\nToko A;"=""+628123456789"""\r\n'))
    expect(row.lead.phone).toBe('="+628123456789"')
  })

  it('leaves anything that is not a phone number as the text it is', () => {
    const row = firstRow(encode('Nama Usaha;Website\r\nToko A;="HYPERLINK(x)"\r\n'))
    expect(row.lead.website).toBe('="HYPERLINK(x)"')
  })
})

// -----------------------------------------------------------------------------
// Headers
// -----------------------------------------------------------------------------

describe('headers', () => {
  it('maps every column the exporter writes that is also an input', () => {
    const row = firstRow(
      encode(
        'Nama Usaha;Kategori Usaha;Alamat;Kota;Rating;Jumlah Review;Website;Email;Telepon;WhatsApp;Sumber\r\n' +
          'Pet Shop Surabaya;Toko hewan;Jl. Darmo 12;Surabaya;"4,8";137;https://petshopsby.com;' +
          'info@petshopsby.com;="+628123456789";="+628129999888";https://maps.google.com/?cid=1\r\n',
      ),
    )
    expect(row.lead).toEqual({
      companyName: 'Pet Shop Surabaya',
      category: 'Toko hewan',
      address: 'Jl. Darmo 12',
      city: 'Surabaya',
      rating: 4.8,
      reviewCount: 137,
      website: 'https://petshopsby.com',
      email: 'info@petshopsby.com',
      phone: '+628123456789',
      whatsapp: '+628129999888',
      sourceUrl: 'https://maps.google.com/?cid=1',
    })
  })

  it('matches case-insensitively after trimming', () => {
    const row = firstRow(encode('  NAMA USAHA ; kota \r\nToko A;Bandung\r\n'))
    expect(row.lead.companyName).toBe('Toko A')
    expect(row.lead.city).toBe('Bandung')
  })

  it('ignores columns it does not know', () => {
    // Our own export writes Skor, Tahap, Alasan Skor and Tanggal Masuk. Rejecting
    // the file over them would mean refusing the file we ourselves produced.
    const row = firstRow(
      encode('Skor;Nama Usaha;Tahap;Catatan Internal\r\n88;Toko A;Baru;apa saja\r\n'),
    )
    expect(row.lead.companyName).toBe('Toko A')
  })

  it('rejects the whole file when Nama Usaha is missing', () => {
    expect(errorOf(encode('Perusahaan;Kota\r\nToko A;Bandung\r\n'))).toBe('header_missing')
  })
})

// -----------------------------------------------------------------------------
// File-level rejections
// -----------------------------------------------------------------------------

describe('a file we will not read', () => {
  it('rejects an empty file', () => {
    expect(errorOf(encode(''))).toBe('empty_file')
    expect(errorOf(encode('   \r\n'))).toBe('empty_file')
  })

  it('rejects a header with no data under it', () => {
    expect(errorOf(encode('Nama Usaha;Kota\r\n'))).toBe('no_rows')
  })

  it('rejects bytes that are not UTF-8', () => {
    expect(errorOf(new Uint8Array([0x4e, 0x61, 0x6d, 0x61, 0xff]))).toBe('not_utf8')
  })

  it('rejects more rows than one batch may carry', () => {
    const body = Array.from({ length: MAX_INGEST_ITEMS + 1 }, (_, i) => `Toko ${i};Bandung`)
    expect(errorOf(encode(`Nama Usaha;Kota\r\n${body.join('\r\n')}\r\n`))).toBe('too_many_rows')
  })

  it('accepts exactly the cap', () => {
    const body = Array.from({ length: MAX_INGEST_ITEMS }, (_, i) => `Toko ${i};Bandung`)
    expect(rowsOf(encode(`Nama Usaha;Kota\r\n${body.join('\r\n')}\r\n`))).toHaveLength(
      MAX_INGEST_ITEMS,
    )
  })

  it('rejects a stray opening quote instead of swallowing the rest of the file', () => {
    // Before this was a file-level error, the input below parsed as ONE row whose
    // companyName was all three lines joined — two leads gone with no report, and
    // three customers' phone numbers written into companies.name.
    const bytes = encode(
      'Nama Usaha;Telepon\r\n' +
        '"Toko A;08123456789\r\n' +
        'Toko B;08123456788\r\n' +
        'Toko C;08123456787\r\n',
    )
    expect(errorOf(bytes)).toBe('unterminated_quote')
  })

  it('still accepts a file whose last field is properly quoted and unterminated by a newline', () => {
    const row = firstRow(encode('Nama Usaha;Kota\r\nToko A;"Bandung"'))
    expect(row.lead.city).toBe('Bandung')
  })
})

// -----------------------------------------------------------------------------
// The caps have to bite during the parse, not after it
// -----------------------------------------------------------------------------

describe('a file that would otherwise exhaust the process', () => {
  /**
   * The caps have to bite **during** the parse. A cap applied to a finished
   * record array cannot bound the allocation it exists to bound: measured on the
   * first version, 1 MB of newlines reached 345 MB of heap and 5 MB reached
   * 1,492 MB — then returned `no_rows`. Three concurrent uploads from one member
   * with `lead:write` would take down every tenant on the instance.
   *
   * Early exit is pinned deterministically rather than by measuring memory: each
   * input below ends with a stray `"`, so a parser that read to the end would
   * answer `unterminated_quote`. Getting the cap's answer instead is proof it
   * stopped early. The heap guard after them is a coarse backstop, not the test.
   */
  const TRAILING_QUOTE = '\r\n"Toko Z;08123456789'
  /** Comfortably under `MAX_CSV_UPLOAD_BYTES`, so the byte cap is not what fires. */
  const FILLER = Math.floor(MAX_CSV_UPLOAD_BYTES / 2)

  it('stops at the row cap instead of reading the rest of the file', () => {
    const body = Array.from({ length: MAX_INGEST_ITEMS * 20 }, (_, i) => `Toko ${i};Bandung`)
    const bytes = encode(`Nama Usaha;Kota\r\n${body.join('\r\n')}${TRAILING_QUOTE}`)
    expect(errorOf(bytes)).toBe('too_many_rows')
  })

  it('stops at the field cap instead of reading the rest of the file', () => {
    const bytes = encode(`Nama Usaha;Kota\r\n${';'.repeat(FILLER)}${TRAILING_QUOTE}`)
    expect(errorOf(bytes)).toBe('too_many_fields')
  })

  it('retains nothing for half a megabyte of blank lines', () => {
    const heapBefore = process.memoryUsage().heapUsed
    expect(errorOf(encode(`Nama Usaha;Kota\r\n${'\n'.repeat(FILLER)}`))).toBe('no_rows')
    const grownMegabytes = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)
    expect(grownMegabytes).toBeLessThan(150)
  })

  it('rejects a file past the byte cap before decoding it at all', () => {
    expect(errorOf(new Uint8Array(MAX_CSV_UPLOAD_BYTES + 1))).toBe('file_too_large')
  })

  it('does not let blank lines eat the row cap', () => {
    // Blank lines are dropped during the parse, so a file padded with them still
    // carries its full allowance of real rows.
    const body = Array.from({ length: MAX_INGEST_ITEMS }, (_, i) => `Toko ${i};Bandung\r\n`)
    expect(rowsOf(encode(`Nama Usaha;Kota\r\n${body.join('\r\n')}`))).toHaveLength(
      MAX_INGEST_ITEMS,
    )
  })

  it('still accepts a wide but sane sheet', () => {
    const header = ['Nama Usaha', ...Array.from({ length: 100 }, (_, i) => `Kolom ${i}`)]
    const row = ['Toko A', ...Array.from({ length: 100 }, () => 'x')]
    expect(firstRow(encode(`${header.join(';')}\r\n${row.join(';')}\r\n`)).lead.companyName).toBe(
      'Toko A',
    )
  })
})

// -----------------------------------------------------------------------------
// The round trip — the case the whole file exists for
// -----------------------------------------------------------------------------

describe('a file we exported can be uploaded back', () => {
  const exported: LeadExportRow = {
    companyName: 'PT Maju Bersama',
    industry: 'Toko hewan peliharaan',
    address: 'Jl. Mawar No. 5; RT 02, "Blok C"',
    city: 'Surabaya',
    rating: 4.7,
    reviewCount: 137,
    website: 'https://majubersama.co.id',
    contactName: 'Budi',
    email: 'info@majubersama.co.id',
    phone: '+628123456789',
    whatsapp: '+628129999888',
    score: 88,
    category: 'hot',
    status: 'qualified',
    scoreReason: 'Rating tinggi, ulasan banyak.',
    campaignName: 'Pet Shop Surabaya',
    sourceUrl: 'https://maps.google.com/?cid=123',
    createdAt: new Date('2026-09-20T03:00:00.000Z'),
  }

  it('returns every field the importer reads, unchanged', () => {
    const row = firstRow(encode(leadsToCsv([exported])))

    expect(row.lead).toEqual({
      companyName: 'PT Maju Bersama',
      category: 'Toko hewan peliharaan',
      address: 'Jl. Mawar No. 5; RT 02, "Blok C"',
      city: 'Surabaya',
      rating: 4.7,
      reviewCount: 137,
      website: 'https://majubersama.co.id',
      email: 'info@majubersama.co.id',
      phone: '+628123456789',
      whatsapp: '+628129999888',
      sourceUrl: 'https://maps.google.com/?cid=123',
    })
  })

  it('undoes the apostrophe the exporter adds to a formula-leading name', () => {
    // textCell prefixes ' to anything starting =, +, - or @, so the file cannot
    // run a formula. Nothing undid it, so `@home Cafe` came back as `'@home Cafe`
    // — and for a company not already in the workspace that apostrophe is what
    // companies.name stores, the export writes again, and the AI addresses the
    // customer by.
    const names = ['=Petshop Sejahtera', '+62 Pet Clinic', '-Toko Hemat', '@home Cafe']

    for (const companyName of names) {
      const row = firstRow(encode(leadsToCsv([{ ...exported, companyName }])))
      expect(row.lead.companyName).toBe(companyName)
    }
  })

  it('undoes it for a phone too short for the formula branch', () => {
    // +6281 fails SAFE_PHONE, so phoneCell falls through to textCell and the
    // apostrophe lands on a phone number instead of a name.
    const row = firstRow(encode(leadsToCsv([{ ...exported, phone: '+6281' }])))
    expect(row.lead.phone).toBe('+6281')
  })

  it('leaves an apostrophe that is not an escape alone', () => {
    const row = firstRow(encode('Nama Usaha\r\n"O\'Brien Petshop"\r\n'))
    expect(row.lead.companyName).toBe("O'Brien Petshop")
  })

  it('survives a workspace-sized file, not just one row', () => {
    const rows = rowsOf(
      encode(leadsToCsv([exported, { ...exported, companyName: 'CV Grooming Ceria' }])),
    )
    expect(rows.map((row) => row.lead.companyName)).toEqual([
      'PT Maju Bersama',
      'CV Grooming Ceria',
    ])
  })
})
