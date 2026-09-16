import { describe, expect, it } from 'vitest'

import {
  CSV_BOM,
  CSV_DELIMITER,
  CSV_NEWLINE,
  type CsvColumn,
  csvFilename,
  dateCell,
  numberCell,
  phoneCell,
  textCell,
  toCsv,
} from '@/lib/export/csv'

/**
 * The export exists to be opened in Excel on an Indonesian machine. Every case
 * below is a way that silently fails to happen: the whole row in column A, a
 * rating that is text, a shop name turned to mojibake, a WhatsApp number turned
 * into 6.28E+12, and a cell that runs a formula.
 */

type Row = { name: string; rating: number | null; phone: string | null }

const COLUMNS: readonly CsvColumn<Row>[] = [
  { header: 'Nama Usaha', cell: (row) => textCell(row.name) },
  { header: 'Rating', cell: (row) => numberCell(row.rating) },
  { header: 'Telepon', cell: (row) => phoneCell(row.phone) },
]

function lines(csv: string): string[] {
  return csv.replace(CSV_BOM, '').split(CSV_NEWLINE).filter((line) => line !== '')
}

describe('the file Excel actually opens', () => {
  it('starts with a UTF-8 BOM', () => {
    // Without it Excel reads the file as the legacy code page and any accent,
    // dash or emoji in a shop name arrives as mojibake.
    expect(toCsv(COLUMNS, [])).toMatch(/^﻿/)
  })

  it('separates with semicolons, the Indonesian list separator', () => {
    expect(CSV_DELIMITER).toBe(';')
    expect(lines(toCsv(COLUMNS, []))[0]).toBe('"Nama Usaha";"Rating";"Telepon"')
  })

  it('ends every row with CRLF, including the last', () => {
    const csv = toCsv(COLUMNS, [{ name: 'Petshop', rating: null, phone: null }])
    expect(csv.endsWith(CSV_NEWLINE)).toBe(true)
  })

  it('writes a header even with no rows, so the file is never blank', () => {
    expect(lines(toCsv(COLUMNS, []))).toHaveLength(1)
  })
})

describe('text cells', () => {
  it('quotes every field and doubles embedded quotes', () => {
    const csv = toCsv(COLUMNS, [{ name: 'Petshop "Bintang"', rating: null, phone: null }])
    expect(lines(csv)[1]).toBe('"Petshop ""Bintang""";"";""')
  })

  it('survives the separator, commas and newlines inside a value', () => {
    const csv = toCsv(COLUMNS, [
      { name: 'Jl. Raya Rungkut No.74; Blok A, lantai 2\nSurabaya', rating: null, phone: null },
    ])
    // One logical row: the quoted field keeps its own newline.
    expect(csv).toContain('"Jl. Raya Rungkut No.74; Blok A, lantai 2\nSurabaya"')
  })

  it('trims, and renders null and undefined as empty', () => {
    expect(textCell('  Petshop  ')).toEqual({ kind: 'text', value: 'Petshop' })
    expect(textCell(null)).toEqual({ kind: 'text', value: '' })
    expect(textCell(undefined)).toEqual({ kind: 'text', value: '' })
  })

  it.each(['=HYPERLINK("http://x","klik")', '+62', '-1+1', '@SUM(A1)', '\t=SUM(A1)'])(
    'defuses %o so the file cannot run anything',
    (dangerous) => {
      const cell = textCell(dangerous)
      expect(cell.kind).toBe('text')
      expect(cell.value.startsWith("'")).toBe(true)
    },
  )

  it('needs no guard for leading whitespace, because trimming removes it first', () => {
    expect(textCell('\tPetshop').value).toBe('Petshop')
  })

  it('leaves an ordinary name alone', () => {
    expect(textCell('Petshop Bintang').value).toBe('Petshop Bintang')
  })
})

describe('number cells', () => {
  it('uses a decimal comma, or the rating is text in Excel', () => {
    expect(numberCell(4.7).value).toBe('4,7')
    expect(numberCell(5).value).toBe('5')
  })

  it('writes no thousands separator', () => {
    expect(numberCell(1208).value).toBe('1208')
  })

  it('renders a missing number as empty, never as 0', () => {
    // 0 reviews and "we do not know" are different facts, and the classification
    // rubric already treats them differently.
    expect(numberCell(null).value).toBe('')
    expect(numberCell(undefined).value).toBe('')
    expect(numberCell(Number.NaN).value).toBe('')
  })
})

describe('phone cells', () => {
  it('keeps a +62 number readable instead of letting Excel make it a number', () => {
    // Typed into a cell, +6281234567890 is a unary-plus formula and comes back as
    // 6281234567890, rendered 6.28E+12. The string literal form survives in both
    // Excel and Sheets.
    expect(phoneCell('+6281234567890')).toEqual({
      kind: 'formula',
      value: '="+6281234567890"',
    })
  })

  it('is written verbatim, not quoted as text', () => {
    const csv = toCsv(COLUMNS, [{ name: 'A', rating: null, phone: '+6281234567890' }])
    expect(lines(csv)[1]).toBe('"A";"";="+6281234567890"')
  })

  it.each(['=cmd|"/c calc"!A1', 'hubungi kami', '+62 (0) 812-3456-7890 ext 4'])(
    'falls back to a defused text cell for %o',
    (value) => {
      expect(phoneCell(value).kind).toBe('text')
    },
  )

  it('accepts the shapes the scraper actually stores', () => {
    expect(phoneCell('+62 812 3456 7890').kind).toBe('formula')
    expect(phoneCell('031-5551234').kind).toBe('formula')
  })

  it('renders an absent number as empty', () => {
    expect(phoneCell(null)).toEqual({ kind: 'text', value: '' })
    expect(phoneCell('   ')).toEqual({ kind: 'text', value: '' })
  })
})

describe('date cells', () => {
  it('writes the Jakarta day, unambiguously', () => {
    // 2026-09-14T17:30:00Z is already the 15th in Jakarta.
    expect(dateCell(new Date('2026-09-14T17:30:00Z')).value).toBe('2026-09-15')
  })

  it('renders a missing or invalid date as empty', () => {
    expect(dateCell(null).value).toBe('')
    expect(dateCell(new Date('nonsense')).value).toBe('')
  })
})

describe('the filename', () => {
  it('carries the Jakarta date and stays ASCII', () => {
    expect(csvFilename('prospek-data-riil', new Date('2026-09-14T17:30:00Z'))).toBe(
      'prospek-data-riil-20260915.csv',
    )
  })

  it('cannot contain a path separator', () => {
    const name = csvFilename('../../etc/passwd', new Date('2026-09-14T03:00:00Z'))
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
  })

  it('survives a workspace slug with nothing usable in it', () => {
    expect(csvFilename('!!!', new Date('2026-09-14T03:00:00Z'))).toBe('export-20260914.csv')
  })
})
