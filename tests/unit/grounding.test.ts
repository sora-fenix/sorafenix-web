import { describe, expect, it } from 'vitest'

import {
  type DraftText,
  decideDraftStatus,
  findClaims,
  findPlaceholders,
  findUngroundedClaims,
  normalizeForGrounding,
} from '@/lib/outreach/grounding'

/**
 * The grounding check is the only thing standing between a model's confidence and
 * a made-up price in a customer's inbox, so it is tested the way the scoring
 * rubric is: pure, no model, no database, every rule named.
 *
 * The knowledge base below is the seeded `maju-bersama` pricelist verbatim. Using
 * the real text rather than a convenient fixture is the point — "Rp 299.000" and
 * "Diskon tahunan 15 persen" are exactly the strings a draft will be checked
 * against in production.
 */

const PRICELIST =
  'Paket Basic: Rp 299.000 per outlet per bulan, mencakup 1 perangkat kasir dan ' +
  'laporan harian. Paket Pro: Rp 599.000 per outlet per bulan, mencakup perangkat ' +
  'tanpa batas, manajemen stok, dan integrasi QRIS. Paket Enterprise: harga khusus, ' +
  'minimum 10 outlet. Semua harga belum termasuk PPN. Diskon tahunan 15 persen untuk ' +
  'pembayaran di muka.'

const FAQ =
  'Berapa lama implementasi? Rata-rata 5 hari kerja untuk 1-3 outlet. Apakah bisa ' +
  'offline? Ya, kasir tetap berjalan offline dan tersinkronisasi otomatis saat ' +
  'koneksi kembali.'

const KNOWLEDGE = [PRICELIST, FAQ]

/** A draft with nothing in it a knowledge base would need to support. */
function clean(overrides: Partial<DraftText> = {}): DraftText {
  return {
    subject: 'Rekap penjualan tiga cabang Toko Sinar Abadi',
    body:
      'Halo Pak Budi,\n\nSaya lihat Toko Sinar Abadi sudah punya beberapa cabang di ' +
      'Surabaya. Rekap penjualan antar cabang biasanya jadi pekerjaan manual yang ' +
      'memakan waktu.\n\nBoleh saya kirim ringkasannya?\n\nPT Maju Bersama Digital',
    cta: 'Boleh saya kirim ringkasannya?',
    ...overrides,
  }
}

describe('normalising a price before comparing it', () => {
  it('folds the spellings of a rupiah amount into one', () => {
    expect(normalizeForGrounding('Rp 299.000')).toBe('rp299.000')
    expect(normalizeForGrounding('Rp299.000')).toBe('rp299.000')
    expect(normalizeForGrounding('IDR 299.000')).toBe('rp299.000')
  })

  it('folds "persen" and "%" into one', () => {
    expect(normalizeForGrounding('Diskon tahunan 15 persen')).toBe('diskon tahunan 15%')
    expect(normalizeForGrounding('diskon 15%')).toBe('diskon 15%')
  })

  it('does not fold two different numbers together', () => {
    // The normaliser may make spellings comparable. It may never make 50 look
    // like 15 — that would ground an invented discount against a real one.
    expect(normalizeForGrounding('50 persen')).not.toBe(normalizeForGrounding('15 persen'))
  })
})

describe('what counts as a claim', () => {
  it('finds rupiah amounts, percentages, discount words and time commitments', () => {
    const claims = findClaims(
      'Paket Pro Rp 599.000 per bulan, diskon 15%, implementasi 5 hari kerja.',
    )

    expect(claims.map((claim) => [claim.kind, claim.term])).toEqual([
      ['currency', 'rp599.000'],
      ['percentage', '15%'],
      ['discount', 'diskon'],
      ['commitment', '5 hari'],
    ])
  })

  it('drops the sentence punctuation that is not part of the amount', () => {
    // Otherwise a grounded price at the end of a sentence reads as invented.
    expect(findClaims('Biayanya Rp 299.000.')).toEqual([
      { kind: 'currency', term: 'rp299.000' },
    ])
  })

  it('reports one claim per distinct term, however often it is repeated', () => {
    const claims = findClaims('Rp 299.000 sekarang, Rp 299.000 bulan depan.')
    expect(claims).toHaveLength(1)
  })

  it('finds a price written the way Indonesian sales copy writes one', () => {
    // The formal "Rp 299.000" is the form a pricelist uses; this is the form a
    // salesperson uses, and the prompt asks the model for natural sales copy. A
    // detector anchored on "Rp" alone would miss the common case entirely.
    for (const [text, term] of [
      ['Paket kami cuma 199 ribu per bulan.', '199 ribu'],
      ['Mulai 1,5 juta per bulan saja.', '1,5 juta'],
      ['Investasinya 299rb per outlet.', '299rb'],
      ['Sekitar 2jt untuk setahun.', '2jt'],
      ['Cukup 299k per bulan.', '299k'],
    ]) {
      expect(findClaims(text ?? '')).toEqual([{ kind: 'currency', term }])
    }
  })

  it('finds a thousands-grouped number with no marker and no magnitude word', () => {
    expect(findClaims('Harga 299.000 per bulan.')).toEqual([
      { kind: 'currency', term: '299.000' },
    ])
  })

  it('reports a marked informal price once, not twice', () => {
    // "Rp 199 ribu" is matched by the marker pattern; the marker-less pattern
    // must not claim its tail as a second, separate price.
    expect(findClaims('Paket Rp 199 ribu per bulan.')).toEqual([
      { kind: 'currency', term: 'rp199 ribu' },
    ])
  })

  it('finds a delivery promise above 999', () => {
    // "1.500 jam" was invisible while the commitment pattern capped at three digits.
    expect(findClaims('Siap dalam 1.500 jam kerja.')).toContainEqual({
      kind: 'commitment',
      term: '1.500 jam',
    })
  })

  it('does not mistake a year, a count or a phone fragment for a price', () => {
    // The reason the bare-number pattern demands the thousands grouping. If these
    // started claiming, every draft would be needs_input and the amber would stop
    // meaning anything.
    expect(findClaims('Sejak 2026 kami melayani 400 outlet di 12 kota.')).toEqual([])
    expect(findClaims('Tim kami 32 orang. Hubungi 0812.3456 kapan saja.')).toEqual([])
  })

  it('leaves ordinary sales copy alone', () => {
    // A check that flags every draft teaches a reviewer to click through it.
    expect(findClaims(clean().body)).toEqual([])
  })
})

describe('grounding a claim in the knowledge base', () => {
  it('accepts a price that is in an active doc verbatim', () => {
    const draft = clean({
      body: 'Paket Basic kami Rp 299.000 per outlet per bulan.',
    })
    expect(findUngroundedClaims(draft, KNOWLEDGE)).toEqual([])
  })

  it('accepts a discount the doc spells differently but means identically', () => {
    // The doc says "Diskon tahunan 15 persen"; the draft says "diskon 15%".
    const draft = clean({ body: 'Ada diskon 15% untuk pembayaran di muka.' })
    expect(findUngroundedClaims(draft, KNOWLEDGE)).toEqual([])
  })

  it('rejects a price that is nowhere in the docs', () => {
    const draft = clean({ body: 'Harganya hanya Rp 1.500.000 per bulan.' })

    expect(findUngroundedClaims(draft, KNOWLEDGE)).toEqual([
      { kind: 'currency', term: 'rp1.500.000' },
    ])
  })

  it('rejects a discount the docs never mention at all', () => {
    const draft = clean({ body: 'Khusus bulan ini gratis untuk dua outlet pertama.' })

    expect(findUngroundedClaims(draft, KNOWLEDGE).map((claim) => claim.term)).toContain(
      'gratis',
    )
  })

  it('scans the subject and the CTA, not only the body', () => {
    const inSubject = findUngroundedClaims(clean({ subject: 'Promo Rp 49.000' }), KNOWLEDGE)
    const inCta = findUngroundedClaims(
      clean({ cta: 'Boleh saya kirim penawaran Rp 49.000?' }),
      KNOWLEDGE,
    )

    // A price moved out of the body is still a price we would be quoting.
    expect(inSubject.map((claim) => claim.term)).toContain('rp49.000')
    expect(inCta.map((claim) => claim.term)).toContain('rp49.000')
  })

  it('refuses a number that is only the digit-suffix of a real one', () => {
    // The defect this block exists for. A plain substring test grounds "5%" on a
    // doc that says "15%", and — the one that decided the fix — "1 hari" on a doc
    // that says "21 hari". A 20x-wrong delivery promise, reported as verified.
    const corpus = [
      'Diskon tahunan 15 persen. Implementasi 21 hari kerja. Paket Basic Rp 299.000 per bulan.',
    ]

    const fivePercent = findUngroundedClaims(clean({ body: 'Diskon 5% bulan ini.' }), corpus)
    const oneDay = findUngroundedClaims(clean({ body: 'Implementasi 1 hari saja.' }), corpus)

    expect(fivePercent.map((claim) => claim.term)).toContain('5%')
    expect(oneDay.map((claim) => claim.term)).toContain('1 hari')
  })

  it('refuses an amount that is only the prefix of a longer one', () => {
    // "Rp 1.500" is not supported by a doc offering "Rp 1.500.000", and the
    // separator between them must not read as a boundary.
    const corpus = ['Paket Enterprise: Rp 1.500.000 per bulan.']
    const claims = findUngroundedClaims(clean({ body: 'Mulai Rp 1.500 per bulan.' }), corpus)

    expect(claims.map((claim) => claim.term)).toContain('rp1.500')
  })

  it('still grounds the exact number it was given', () => {
    // The control the fix must not break: a boundary check that flags a grounded
    // price would be worse than the bug it closes.
    const corpus = [
      'Diskon tahunan 15 persen. Implementasi 21 hari kerja. Paket Basic Rp 299.000 per bulan.',
    ]

    expect(
      findUngroundedClaims(
        clean({ body: 'Diskon 15%, implementasi 21 hari, Rp 299.000 per bulan.' }),
        corpus,
      ),
    ).toEqual([])
  })

  it('refuses an informal price the docs do not support', () => {
    // The leak that reached the approval queue with no amber and no reason: a
    // price written "199 ribu" produced no claim at all.
    const draft = clean({ body: 'Paket kami cuma 199 ribu per bulan.' })
    expect(findUngroundedClaims(draft, KNOWLEDGE).map((claim) => claim.term)).toEqual([
      '199 ribu',
    ])
  })

  it('accepts a bare amount the docs state with the currency marker', () => {
    // The doc says "Rp 299.000"; the draft quotes it and drops the "Rp". Same
    // price, and the doc is the side asserting it is money.
    const draft = clean({ body: 'Harga 299.000 per outlet per bulan.' })
    expect(findUngroundedClaims(draft, KNOWLEDGE)).toEqual([])
  })

  it('does not accept a marked price on the strength of a bare number in a doc', () => {
    // The asymmetry is deliberate: "21.000" in a doc may be a quantity, a year or
    // an outlet count, and it must not license quoting it as a price.
    const draft = clean({ body: 'Biayanya Rp 21.000 per bulan.' })
    const corpus = ['Kami melayani 21.000 transaksi setiap hari.']

    expect(findUngroundedClaims(draft, corpus).map((claim) => claim.term)).toEqual([
      'rp21.000',
    ])
  })

  it('grounds nothing when the workspace has no active docs', () => {
    const draft = clean({ body: 'Paket Basic kami Rp 299.000 per outlet per bulan.' })
    expect(findUngroundedClaims(draft, [])).toHaveLength(1)
  })
})

describe('the placeholders a human fills', () => {
  it('finds the bracketed gaps and reports each once', () => {
    const draft = clean({
      body: 'Paket Pro [harga paket] per outlet, mulai [tanggal mulai] atau [harga paket].',
    })
    expect(findPlaceholders(draft)).toEqual(['[harga paket]', '[tanggal mulai]'])
  })
})

describe('deciding the draft status', () => {
  it('lets a clean, complete draft reach the approval queue', () => {
    const decision = decideDraftStatus({
      draft: clean(),
      modelMissingInfo: [],
      knowledge: KNOWLEDGE,
    })

    expect(decision.status).toBe('pending_approval')
    expect(decision.missingInfo).toEqual([])
  })

  it('holds a draft the model itself reported a gap in', () => {
    // SPEC §5: missing_info non-empty means needs_input. Believed in the
    // direction that makes the draft less sendable.
    const decision = decideDraftStatus({
      draft: clean(),
      modelMissingInfo: ['Jumlah cabang tidak tersedia'],
      knowledge: KNOWLEDGE,
    })

    expect(decision.status).toBe('needs_input')
    expect(decision.missingInfo).toEqual(['Jumlah cabang tidak tersedia'])
  })

  it('holds a draft with a placeholder still in it', () => {
    const decision = decideDraftStatus({
      draft: clean({ body: 'Paket Pro mulai [harga paket] per outlet.' }),
      modelMissingInfo: [],
      knowledge: KNOWLEDGE,
    })

    expect(decision.status).toBe('needs_input')
    expect(decision.placeholders).toEqual(['[harga paket]'])
    expect(decision.missingInfo.join(' ')).toContain('[harga paket]')
  })

  it('holds a draft with an invented price EVEN IF the model reported no gaps', () => {
    // The case this whole module exists for. The model is confident and wrong;
    // the code decides, and it decides needs_input.
    const decision = decideDraftStatus({
      draft: clean({ body: 'Paket kami hanya Rp 1.500.000 per bulan, sudah termasuk semua.' }),
      modelMissingInfo: [],
      knowledge: KNOWLEDGE,
    })

    expect(decision.status).toBe('needs_input')
    expect(decision.ungrounded).toEqual([{ kind: 'currency', term: 'rp1.500.000' }])
    expect(decision.missingInfo.join(' ')).toContain('rp1.500.000')
  })

  it('reports every reason at once, not just the first', () => {
    // A reviewer who fixes the placeholder and finds the price still wrong has
    // been made to do the job twice.
    const decision = decideDraftStatus({
      draft: clean({
        body: 'Paket kami Rp 1.500.000 per bulan, siap dalam [lama implementasi].',
      }),
      modelMissingInfo: ['Nama kontak tidak tersedia'],
      knowledge: KNOWLEDGE,
    })

    expect(decision.status).toBe('needs_input')
    expect(decision.missingInfo).toHaveLength(3)
  })

  it('does not repeat a reason the model and the scan both found', () => {
    const decision = decideDraftStatus({
      draft: clean({ body: 'Mulai [harga paket] per outlet.' }),
      modelMissingInfo: ['Lengkapi bagian kosong: [harga paket]'],
      knowledge: KNOWLEDGE,
    })

    expect(decision.missingInfo).toEqual(['Lengkapi bagian kosong: [harga paket]'])
  })

  it('writes every reason in Bahasa Indonesia', () => {
    // These reach the approval queue, where a salesperson reads them. Rule 8.
    const decision = decideDraftStatus({
      draft: clean({ body: 'Diskon 40% bulan ini, mulai [tanggal].' }),
      modelMissingInfo: [],
      knowledge: KNOWLEDGE,
    })

    expect(decision.missingInfo.join(' ')).toContain('Klaim tanpa dasar')
    expect(decision.missingInfo.join(' ')).toContain('Lengkapi bagian kosong')
  })
})
