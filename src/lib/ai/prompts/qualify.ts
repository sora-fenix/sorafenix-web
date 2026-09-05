import { NEUTRAL_SCORE, SCORE_FACTORS } from '@/lib/scoring/rubric'

/**
 * The qualification prompt (docs/SPEC.md §4).
 *
 * A file, not an inline string literal, so a change to how leads are judged shows
 * up as a reviewable diff (.claude/rules/ai.md). Nothing here talks to a model —
 * it builds two strings and `lib/scoring/score.ts` hands them to `runAgent`.
 *
 * Everything the model sees comes from a database column. A field with no value is
 * rendered as an explicit "tidak tersedia" rather than left out: the model is told
 * what is missing, so it can score that factor neutral instead of filling the
 * silence with something plausible.
 */

export type QualifyCompany = {
  readonly name: string
  readonly industry: string | null
  readonly city: string | null
  readonly sizeBand: string | null
  readonly employeeCount: number | null
  readonly description: string | null
}

export type QualifyContact = {
  readonly name: string | null
  readonly position: string | null
  readonly department: string | null
}

export type QualifyProduct = {
  readonly name: string
  readonly description: string | null
  readonly valueProp: string | null
  /** `products.icp` — jsonb, shape owned by whoever wrote the row. */
  readonly icp: unknown
}

export type QualifyContext = {
  readonly company: QualifyCompany
  readonly contact: QualifyContact | null
  readonly product: QualifyProduct | null
}

const MISSING = 'tidak tersedia'

export function qualifySystemPrompt(): string {
  const factorList = SCORE_FACTORS.map(
    (factor) => `- ${factor.key} (${factor.label})`,
  ).join('\n')

  return `Kamu menilai kelayakan calon pelanggan (lead) untuk tim penjualan B2B di Indonesia.

Kamu memberi nilai 0-100 untuk enam faktor berikut:
${factorList}

ATURAN YANG TIDAK BOLEH DILANGGAR:

1. Nilai HANYA berdasarkan data yang diberikan di bawah. Jangan memakai pengetahuan
   umummu tentang perusahaan mana pun. Kamu tidak tahu apa pun tentang perusahaan ini
   selain yang tertulis.
2. Jika sebuah faktor tidak punya dasar pada data yang diberikan, beri nilai tepat
   ${NEUTRAL_SCORE} (netral) dan tulis di evidence bahwa datanya tidak tersedia.
   JANGAN menaikkan nilai karena menebak, dan jangan menurunkannya karena data kosong.
3. Setiap evidence harus menyebut fakta yang benar-benar ada di data. Satu kalimat.
   Kalau kamu tidak bisa menyebut fakta yang tertulis, berarti faktor itu bernilai
   ${NEUTRAL_SCORE}.
4. Kamu TIDAK menghitung nilai akhir. Hanya enam nilai per faktor. Total dihitung
   oleh sistem.

Tulis semua evidence dan alasan dalam Bahasa Indonesia yang wajar, seperti catatan
seorang sales, bukan terjemahan kaku.`
}

export function qualifyPrompt(context: QualifyContext): string {
  return [
    '## Produk yang kita jual', '',
    renderProduct(context.product), '',
    '## Calon pelanggan', '',
    renderCompany(context.company), '',
    '## Kontak di perusahaan itu', '',
    renderContact(context.contact), '',
    '## Tugas', '',
    'Beri nilai enam faktor di atas untuk calon pelanggan ini, dengan satu kalimat',
    'evidence per faktor, lalu tulis alasan ringkas 2-3 kalimat.',
  ].join('\n')
}

// -----------------------------------------------------------------------------
// Rendering — every value below comes from a column
// -----------------------------------------------------------------------------

function line(label: string, value: string | number | null): string {
  const shown = value === null || value === '' ? MISSING : String(value)
  return `- ${label}: ${shown}`
}

function renderProduct(product: QualifyProduct | null): string {
  if (product === null) {
    // Two of the six factors judge the lead against what we sell. Saying so plainly
    // is what makes them score neutral instead of being invented.
    return [
      `Belum ada produk yang tercatat untuk workspace ini (${MISSING}).`,
      '',
      `Karena itu faktor industry_fit dan product_need TIDAK punya dasar:`,
      `beri keduanya nilai ${NEUTRAL_SCORE} dan sebutkan alasannya di evidence.`,
    ].join('\n')
  }

  const rows = [
    line('Nama produk', product.name),
    line('Deskripsi', product.description),
    line('Keunggulan utama', product.valueProp),
  ]

  const icp = renderIcp(product.icp)
  if (icp !== null) {
    rows.push('- Profil pelanggan ideal:', icp)
  } else {
    rows.push(line('Profil pelanggan ideal', null))
  }

  return rows.join('\n')
}

function renderCompany(company: QualifyCompany): string {
  return [
    line('Nama', company.name),
    line('Industri', company.industry),
    line('Kota', company.city),
    line('Ukuran (band karyawan)', company.sizeBand),
    line('Perkiraan jumlah karyawan', company.employeeCount),
    line('Deskripsi', company.description),
  ].join('\n')
}

function renderContact(contact: QualifyContact | null): string {
  if (contact === null) {
    return `Belum ada kontak tercatat (${MISSING}). Faktor decision_maker tidak punya dasar.`
  }
  return [
    line('Nama', contact.name),
    line('Jabatan', contact.position),
    line('Divisi', contact.department),
  ].join('\n')
}

/**
 * `products.icp` is jsonb written by whoever created the product, so its shape is
 * not ours to assume. Rendered as indented key/value lines when it is a plain
 * object, and skipped entirely when it is anything else — a malformed ICP must not
 * take the whole prompt down.
 */
function renderIcp(icp: unknown): string | null {
  if (typeof icp !== 'object' || icp === null || Array.isArray(icp)) return null

  const entries = Object.entries(icp)
  if (entries.length === 0) return null

  return entries
    .map(([key, value]) => `  - ${key}: ${renderIcpValue(value)}`)
    .join('\n')
}

function renderIcpValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  if (value === null || value === undefined) return MISSING
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
