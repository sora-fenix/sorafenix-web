import { PLACEHOLDER_EXAMPLE } from '@/lib/outreach/grounding'

/**
 * The first-touch email prompt (docs/SPEC.md §5).
 *
 * A file, not an inline string literal, so a change to what the AI is allowed to
 * write about our own product shows up as a reviewable diff
 * (.claude/rules/ai.md). Nothing here talks to a model — it builds two strings and
 * `lib/outreach/draft.ts` hands them to `runAgent`.
 *
 * Everything the model sees comes from a database column. A field with no value is
 * rendered as an explicit "tidak tersedia", exactly as `prompts/qualify.ts` does
 * it: the model is told what is missing so it leaves a bracketed gap instead of
 * filling the silence with something plausible.
 *
 * SPEC §5 also lists per-campaign language, tone and length. `campaigns` has no
 * columns for any of the three, so this slice fixes them at Bahasa Indonesia,
 * professional, medium. Wiring them is a schema change and waits for one.
 */

export type GenerateCompany = {
  readonly name: string
  readonly industry: string | null
  readonly city: string | null
  readonly sizeBand: string | null
  readonly employeeCount: number | null
  readonly description: string | null
  readonly website: string | null
}

export type GenerateContact = {
  readonly name: string | null
  readonly position: string | null
  readonly department: string | null
}

export type GenerateProduct = {
  readonly name: string
  readonly description: string | null
  readonly valueProp: string | null
}

/** One row of `knowledge_docs`, already filtered to `is_active`. */
export type GenerateKnowledgeDoc = {
  readonly type: string
  readonly title: string
  readonly content: string
}

export type GenerateLead = {
  readonly score: number | null
  readonly category: string | null
  readonly scoreReason: string | null
}

export type GenerateContext = {
  /** `workspaces.name` — the only name the email may sign off with. */
  readonly senderName: string
  readonly product: GenerateProduct | null
  readonly company: GenerateCompany
  readonly contact: GenerateContact | null
  readonly lead: GenerateLead
  readonly knowledge: readonly GenerateKnowledgeDoc[]
}

const MISSING = 'tidak tersedia'

/**
 * Long documents are clipped rather than dropped, so a pricelist's first entries
 * still reach the model. The grounding check reads the FULL stored content, so
 * clipping can only make the model more cautious — never less grounded.
 */
const MAX_DOC_CHARS = 4000

export function generateSystemPrompt(): string {
  return `Kamu menulis satu email penawaran pertama (first touch) untuk tim penjualan B2B di Indonesia.

Bahasa Indonesia. Nada profesional tapi hangat, seperti orang sales yang menulis
sendiri. Panjang badan email 110-170 kata.

ATURAN YANG TIDAK BOLEH DILANGGAR:

1. JANGAN menyebut harga, biaya, diskon, promo, potongan, persentase, lama
   pengerjaan, masa garansi, atau spesifikasi produk — KECUALI kalimat itu ada
   persis di "Materi resmi" di bawah. Sistem memeriksa ini kata per kata; draf
   yang mengarang angka otomatis ditahan dan tidak pernah terkirim.
2. Kamu tidak tahu apa pun tentang calon pelanggan ini selain yang tertulis di
   bawah. Jangan memakai pengetahuan umummu tentang perusahaan mana pun.
3. Kalau sebuah fakta tidak ada di data, JANGAN menebak. Tulis tanda kurung siku
   di posisi fakta itu seharusnya, misalnya ${PLACEHOLDER_EXAMPLE}, lalu sebutkan
   fakta yang hilang itu di missing_info. Tempat kosong yang diisi manusia jauh
   lebih baik daripada angka karangan.
4. Setiap kalimat personalisasi harus bersandar pada satu data yang tertulis di
   bawah, dan data itu harus kamu sebut di personalization_used, misalnya
   "kota: Surabaya". Kalau sebuah kalimat tidak bisa kamu petakan ke satu data,
   hapus kalimatnya.
5. Tutup email dengan nama perusahaan kita saja. Jangan mengarang nama pengirim,
   jabatan, nomor telepon, atau alamat.
6. Akhiri badan email dengan satu ajakan ringan — minta balasan atau 15 menit
   ngobrol — dan salin kalimat ajakan itu persis ke field cta. Email pertama tidak
   meminta pembelian.

BENTUK KELUARAN:

- subject: satu baris, maksimal sekitar 60 karakter, tanpa huruf kapital semua dan
  tanpa tanda seru berlebihan.
- body: salam pembuka, satu kalimat pembuka yang menyebut sesuatu yang nyata
  tentang perusahaan mereka, satu atau dua kalimat tentang masalah yang kita bantu
  selesaikan, lalu kalimat ajakan, lalu penutup.
- cta: kalimat ajakan tadi.
- personalization_used: daftar data yang kamu pakai.
- missing_info: daftar fakta yang tidak tersedia dan kamu tinggalkan kosong.
- confidence: 0 sampai 1, seberapa yakin kamu email ini layak dikirim apa adanya.`
}

export function generatePrompt(context: GenerateContext): string {
  return [
    '## Perusahaan kita',
    '',
    `- Nama pengirim (untuk penutup): ${context.senderName}`,
    renderProduct(context.product),
    '',
    '## Materi resmi (satu-satunya sumber untuk harga, paket, dan spesifikasi)',
    '',
    renderKnowledge(context.knowledge),
    '',
    '## Calon pelanggan',
    '',
    renderCompany(context.company),
    '',
    '## Kontak yang kita tulisi',
    '',
    renderContact(context.contact),
    '',
    '## Penilaian lead (hasil kualifikasi kita sendiri, jangan dikutip ke pelanggan)',
    '',
    renderLead(context.lead),
    '',
    '## Tugas',
    '',
    'Tulis satu email pertama untuk kontak di atas. Ini kontak pertama: belum ada',
    'percakapan sebelumnya yang bisa kamu rujuk.',
  ].join('\n')
}

// -----------------------------------------------------------------------------
// Rendering — every value below comes from a column
// -----------------------------------------------------------------------------

function line(label: string, value: string | number | null): string {
  const shown = value === null || value === '' ? MISSING : String(value)
  return `- ${label}: ${shown}`
}

function renderProduct(product: GenerateProduct | null): string {
  if (product === null) {
    return [
      `- Produk: ${MISSING}`,
      '',
      'Belum ada produk tercatat untuk workspace ini. Jangan mengarang nama atau',
      `manfaat produk: tinggalkan kurung siku seperti ${PLACEHOLDER_EXAMPLE} di`,
      'tempatnya dan sebutkan di missing_info.',
    ].join('\n')
  }

  return [
    line('Produk', product.name),
    line('Deskripsi', product.description),
    line('Keunggulan utama', product.valueProp),
  ].join('\n')
}

function renderKnowledge(docs: readonly GenerateKnowledgeDoc[]): string {
  if (docs.length === 0) {
    return [
      `Tidak ada materi resmi yang aktif (${MISSING}).`,
      '',
      'Artinya TIDAK ADA satu pun harga, paket, diskon, lama pengerjaan atau',
      'spesifikasi yang boleh kamu sebut di email ini. Kalau email butuh salah',
      'satunya, tinggalkan kurung siku dan sebutkan di missing_info.',
    ].join('\n')
  }

  return docs
    .map((doc) => `### ${doc.title} (${doc.type})\n${clip(doc.content)}`)
    .join('\n\n')
}

function renderCompany(company: GenerateCompany): string {
  return [
    line('Nama', company.name),
    line('Industri', company.industry),
    line('Kota', company.city),
    line('Ukuran (band karyawan)', company.sizeBand),
    line('Perkiraan jumlah karyawan', company.employeeCount),
    line('Website', company.website),
    line('Deskripsi', company.description),
  ].join('\n')
}

function renderContact(contact: GenerateContact | null): string {
  if (contact === null) {
    return [
      `Nama kontak ${MISSING}.`,
      '',
      'Pakai salam netral dan jangan mengarang nama orang.',
    ].join('\n')
  }

  return [
    line('Nama', contact.name),
    line('Jabatan', contact.position),
    line('Divisi', contact.department),
  ].join('\n')
}

function renderLead(lead: GenerateLead): string {
  return [
    line('Skor', lead.score),
    line('Kategori', lead.category),
    line('Alasan skor', lead.scoreReason),
  ].join('\n')
}

function clip(content: string): string {
  if (content.length <= MAX_DOC_CHARS) return content
  return `${content.slice(0, MAX_DOC_CHARS)}…`
}
