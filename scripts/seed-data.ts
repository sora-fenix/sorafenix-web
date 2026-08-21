/**
 * Source pools for the demo seed. Indonesian by design — the product sells to
 * Indonesian SMBs, so placeholder data that reads as "Acme Corp, Springfield"
 * hides exactly the layout and truncation problems we need to see.
 *
 * No faker dependency: no faker locale ships convincing PT/CV trade names,
 * Indonesian jabatan, or .co.id domains, which is most of what matters here.
 */

/**
 * Deterministic PRNG (mulberry32). The seed must produce byte-identical data on
 * every run so tests/integration/seed.test.ts can assert exact values and so a
 * re-seed is a no-op rather than a diff.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) {
    throw new Error('pick() called with an empty array')
  }
  return item
}

export function pickIndex(rng: () => number, length: number): number {
  return Math.floor(rng() * length)
}

export function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

// -----------------------------------------------------------------------------
// Company names
// -----------------------------------------------------------------------------

export const COMPANY_PREFIXES = ['PT', 'PT', 'PT', 'CV'] as const

export const COMPANY_WORDS_A = [
  'Sinar',
  'Maju',
  'Karya',
  'Sumber',
  'Cahaya',
  'Mitra',
  'Berkah',
  'Sentosa',
  'Anugerah',
  'Bintang',
  'Cipta',
  'Graha',
  'Harapan',
  'Indah',
  'Jaya',
  'Kencana',
  'Lestari',
  'Mandiri',
  'Nusantara',
  'Prima',
] as const

export const COMPANY_WORDS_B = [
  'Abadi',
  'Sejahtera',
  'Makmur',
  'Utama',
  'Perkasa',
  'Gemilang',
  'Mulia',
  'Sentosa',
  'Bersama',
  'Nusantara',
  'Persada',
  'Pratama',
  'Selaras',
  'Teknologi',
  'Digital',
  'Logistik',
  'Pangan',
  'Niaga',
  'Karya',
  'Mandiri',
] as const

// -----------------------------------------------------------------------------
// Geography
// -----------------------------------------------------------------------------

/** City paired with the landline area code a business there would actually use. */
export const CITIES = [
  { name: 'Jakarta Selatan', area: '21' },
  { name: 'Jakarta Pusat', area: '21' },
  { name: 'Jakarta Barat', area: '21' },
  { name: 'Tangerang', area: '21' },
  { name: 'Bekasi', area: '21' },
  { name: 'Bandung', area: '22' },
  { name: 'Surabaya', area: '31' },
  { name: 'Sidoarjo', area: '31' },
  { name: 'Semarang', area: '24' },
  { name: 'Yogyakarta', area: '274' },
  { name: 'Solo', area: '271' },
  { name: 'Malang', area: '341' },
  { name: 'Medan', area: '61' },
  { name: 'Palembang', area: '711' },
  { name: 'Makassar', area: '411' },
  { name: 'Denpasar', area: '361' },
  { name: 'Balikpapan', area: '542' },
  { name: 'Batam', area: '778' },
] as const

export const STREETS = [
  // Deliberately only street names that exist in most Indonesian cities, so a
  // random street/city pairing never produces something like
  // "Jl. Raya Serpong, Makassar".
  'Jl. Ahmad Yani',
  'Jl. Diponegoro',
  'Jl. Sudirman',
  'Jl. Gatot Subroto',
  'Jl. Merdeka',
  'Jl. Pahlawan',
  'Jl. Pemuda',
  'Jl. Veteran',
  'Jl. Imam Bonjol',
  'Jl. Industri Raya',
] as const

// -----------------------------------------------------------------------------
// Industry and size
// -----------------------------------------------------------------------------

/**
 * Industries split by how well they fit the demo product (a POS/cashier system).
 * The seed picks from the right bucket for the score tier it is building, so a
 * construction company never turns up as a hot POS lead.
 */
export const ICP_INDUSTRIES = ['Ritel', 'Makanan & Minuman'] as const

export const ADJACENT_INDUSTRIES = [
  'Pariwisata',
  'Otomotif',
  'Kesehatan',
  'Pendidikan',
] as const

export const OFF_TARGET_INDUSTRIES = [
  'Manufaktur',
  'Logistik',
  'Properti',
  'Agrikultur',
  'Jasa Keuangan',
  'Konstruksi',
] as const

export const INDUSTRIES = [
  ...ICP_INDUSTRIES,
  ...ADJACENT_INDUSTRIES,
  ...OFF_TARGET_INDUSTRIES,
] as const

/** Employee-count bands, with the range each one implies. */
export const SIZE_BANDS = [
  { band: '1-10', min: 3, max: 10 },
  { band: '11-50', min: 11, max: 50 },
  { band: '51-200', min: 51, max: 200 },
  { band: '201-500', min: 201, max: 500 },
] as const

// -----------------------------------------------------------------------------
// People
// -----------------------------------------------------------------------------

export const FIRST_NAMES = [
  'Budi',
  'Siti',
  'Agus',
  'Dewi',
  'Eko',
  'Rina',
  'Joko',
  'Ani',
  'Hendra',
  'Maya',
  'Rudi',
  'Fitri',
  'Bambang',
  'Lestari',
  'Dimas',
  'Ratna',
  'Yusuf',
  'Indah',
  'Andi',
  'Wulan',
  'Rizky',
  'Nurul',
  'Teguh',
  'Sari',
] as const

export const LAST_NAMES = [
  'Santoso',
  'Rahayu',
  'Pratama',
  'Lestari',
  'Wibowo',
  'Kusuma',
  'Susilo',
  'Wijaya',
  'Gunawan',
  'Sari',
  'Hidayat',
  'Nugroho',
  'Saputra',
  'Halim',
  'Setiawan',
  'Maulana',
  'Permana',
  'Firmansyah',
] as const

export const POSITIONS = [
  { title: 'Direktur', department: 'Manajemen', decisionMaker: true },
  { title: 'Owner', department: 'Manajemen', decisionMaker: true },
  { title: 'General Manager', department: 'Manajemen', decisionMaker: true },
  { title: 'Manajer Operasional', department: 'Operasional', decisionMaker: true },
  { title: 'Manajer Pemasaran', department: 'Pemasaran', decisionMaker: true },
  { title: 'Kepala Cabang', department: 'Operasional', decisionMaker: true },
  { title: 'Purchasing Manager', department: 'Pengadaan', decisionMaker: true },
  { title: 'IT Manager', department: 'Teknologi', decisionMaker: false },
  { title: 'Supervisor Toko', department: 'Operasional', decisionMaker: false },
  { title: 'Staf Administrasi', department: 'Administrasi', decisionMaker: false },
] as const

// -----------------------------------------------------------------------------
// Lead scoring copy
// -----------------------------------------------------------------------------

/** The six factors and weights from docs/SPEC.md §4. Must sum to 100. */
export const SCORE_FACTORS = [
  { key: 'industry_fit', label: 'Kesesuaian industri', weight: 25 },
  { key: 'product_need', label: 'Kebutuhan produk', weight: 25 },
  { key: 'company_size', label: 'Ukuran perusahaan', weight: 15 },
  { key: 'decision_maker', label: 'Ketersediaan pengambil keputusan', weight: 15 },
  { key: 'location', label: 'Lokasi', weight: 10 },
  { key: 'digital_signals', label: 'Sinyal digital / bisnis', weight: 10 },
] as const

/** How well a given factor scored, which drives both the number and the wording. */
export type FitLevel = 'high' | 'mid' | 'low'

export const ICP_CITY_NAMES: readonly string[] = [
  'Jakarta Selatan',
  'Jakarta Pusat',
  'Jakarta Barat',
  'Tangerang',
  'Bekasi',
  'Bandung',
  'Surabaya',
  'Semarang',
]

/** Employee bands the product actually sells well into. */
export const ICP_SIZE_BANDS: readonly string[] = ['11-50', '51-200']

/**
 * Sub-score ranges per fit level. The model returns numbers in these bands and
 * code computes the weighted total (docs/SPEC.md §4) — the seed mirrors that so
 * the stored score_factors actually add up to the stored score.
 */
export const LEVEL_SCORE_RANGE: Record<FitLevel, readonly [number, number]> = {
  high: [78, 96],
  mid: [48, 72],
  low: [12, 40],
}

/**
 * Evidence sentences, one per factor per fit level. Interpolated with the row's
 * real attributes, so the evidence never contradicts the record it describes.
 */
export const EVIDENCE_TEMPLATES: Record<string, Record<FitLevel, string>> = {
  industry_fit: {
    high: 'Bergerak di bidang {industry} dengan transaksi harian tinggi, tepat di target pasar produk ini.',
    mid: 'Industri {industry} bersinggungan dengan target pasar, tetapi bukan fokus utama.',
    low: 'Industri {industry} berada di luar target pasar produk ini.',
  },
  product_need: {
    high: 'Skala {employees} karyawan di beberapa titik layanan, kebutuhan kasir terpusat terlihat jelas.',
    mid: 'Skala {employees} karyawan memungkinkan kebutuhan kasir, tetapi belum terkonfirmasi dari data tersimpan.',
    low: 'Tidak ada sinyal kebutuhan sistem kasir pada data yang tersimpan.',
  },
  company_size: {
    high: 'Perkiraan {employees} karyawan (band {size}), tepat di rentang pelanggan ideal.',
    mid: 'Perkiraan {employees} karyawan (band {size}), berada di tepi rentang ideal.',
    low: 'Perkiraan {employees} karyawan (band {size}), di luar rentang pelanggan ideal.',
  },
  decision_maker: {
    high: 'Kontak tersimpan menjabat {position}, pengambil keputusan langsung.',
    mid: 'Kontak tersimpan menjabat {position}, kemungkinan perlu eskalasi internal.',
    low: 'Kontak tersimpan menjabat {position}, jauh dari jalur pengambilan keputusan.',
  },
  location: {
    high: 'Berlokasi di {city}, termasuk area layanan utama dengan dukungan on-site.',
    mid: 'Berlokasi di {city}, terjangkau lewat mitra teknis setempat.',
    low: 'Berlokasi di {city}, di luar area layanan utama sehingga dukungan hanya jarak jauh.',
  },
  digital_signals: {
    high: 'Punya situs aktif di {domain} dan email dengan domain sendiri.',
    mid: 'Punya situs di {domain}, namun informasi produk yang tersedia terbatas.',
    low: 'Jejak digital minim; hanya nomor telepon yang bisa diverifikasi.',
  },
}

/**
 * The 2-3 sentence summary stored in leads.score_reason, in Bahasa Indonesia
 * per docs/SPEC.md §4. Built from the same attributes as the factors above.
 */
export const REASON_TEMPLATES: Record<'hot' | 'warm' | 'cold', string> = {
  hot: '{company} bergerak di bidang {industry} dengan perkiraan {employees} karyawan di {city}, dan kontak utamanya menjabat {position} sehingga jalur keputusan pendek. Kesesuaian industri dan indikasi kebutuhan produk sama-sama kuat. Prioritaskan untuk dihubungi minggu ini.',
  warm: '{company} berada di {city} dengan perkiraan {employees} karyawan, dan industri {industry} masih bersinggungan dengan target pasar. Kontak yang tersimpan menjabat {position}, sehingga kebutuhan produk perlu dipastikan lewat satu percakapan. Layak dihubungi setelah prospek panas selesai.',
  cold: 'Industri {industry} berada di luar target pasar dan kontak yang tersimpan menjabat {position}. Dengan perkiraan {employees} karyawan di {city}, tidak ada sinyal kebutuhan yang cukup kuat pada data tersimpan. Simpan untuk nurture jangka panjang.',
}

/** Replaces every {placeholder} with the matching value. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
}

// -----------------------------------------------------------------------------
// Message copy
// -----------------------------------------------------------------------------

export const EMAIL_SUBJECTS = [
  'Sistem kasir untuk {company}',
  'Mengurangi antrean kasir di {company}',
  'Laporan penjualan harian untuk {company}',
  'Perkenalan: solusi kasir multi-cabang',
] as const

export const EMAIL_BODY_TEMPLATE = `Selamat pagi Bapak/Ibu {name},

Saya {sender} dari PT Maju Bersama Digital. Kami membantu bisnis {industry} di {city} merapikan proses kasir dan laporan penjualan harian.

Dari yang kami lihat, {company} mengelola lebih dari satu titik layanan. Biasanya di titik itu rekap penjualan antar cabang mulai memakan waktu.

Apakah Bapak/Ibu terbuka untuk obrolan singkat 15 menit minggu ini?

Salam,
{sender}`

/** Inbound replies, one per classification label the reply reader must handle. */
export const INBOUND_REPLIES = [
  {
    body: 'Menarik, boleh dikirimkan proposal dan pricelist?',
    label: 'REQUEST_PROPOSAL',
  },
  { body: 'Berapa harganya untuk 3 cabang?', label: 'ASKING_PRICE' },
  {
    body: 'Boleh info lebih lengkap soal fitur laporannya?',
    label: 'ASKING_INFORMATION',
  },
  { body: 'Bisa jadwalkan demo minggu depan?', label: 'REQUEST_MEETING' },
  { body: 'Terima kasih, tapi kami sudah pakai sistem lain.', label: 'NOT_INTERESTED' },
  { body: 'Coba hubungi lagi bulan depan ya, sekarang lagi sibuk.', label: 'FOLLOW_UP_LATER' },
  { body: 'Mohon jangan hubungi saya lagi.', label: 'UNSUBSCRIBE' },
  { body: 'Saya sedang cuti sampai tanggal 20.', label: 'OUT_OF_OFFICE' },
  { body: 'Sepertinya salah sambung, saya bukan bagian pengadaan.', label: 'WRONG_CONTACT' },
  { body: 'Kami sedang pertimbangkan, nanti kami kabari.', label: 'CONSIDERING' },
] as const

export const WA_TEMPLATE_BODY =
  'Halo {name}, saya {sender} dari PT Maju Bersama Digital. Kami bantu bisnis {industry} rapikan kasir dan laporan penjualan. Boleh saya kirim ringkasannya?'

// -----------------------------------------------------------------------------
// Activity types
// -----------------------------------------------------------------------------

export const ACTIVITY_TYPES = [
  { type: 'lead_created', actor: 'system', channel: null },
  { type: 'company_enriched', actor: 'ai', channel: null },
  { type: 'lead_scored', actor: 'ai', channel: null },
  { type: 'draft_generated', actor: 'ai', channel: 'email' },
  { type: 'draft_approved', actor: 'human', channel: 'email' },
  { type: 'message_sent', actor: 'system', channel: 'email' },
  { type: 'message_opened', actor: 'system', channel: 'email' },
  { type: 'reply_received', actor: 'system', channel: 'email' },
  { type: 'reply_classified', actor: 'ai', channel: 'email' },
  { type: 'status_changed', actor: 'ai', channel: null },
  { type: 'owner_assigned', actor: 'human', channel: null },
  { type: 'note_added', actor: 'human', channel: null },
  { type: 'whatsapp_sent', actor: 'system', channel: 'whatsapp' },
  { type: 'sequence_stopped', actor: 'system', channel: null },
] as const

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** "PT Sinar Jaya Abadi" → "sinarjayaabadi" */
export function slugifyCompany(name: string): string {
  return name
    .replace(/^(PT|CV)\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** "Budi Santoso" → "budi.santoso" */
export function emailLocalPart(fullName: string): string {
  return fullName
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .replace(/\s+/g, '.')
}

/**
 * Indonesian mobile number in both the form a scraper finds it and the form the
 * system stores it. docs/SPEC.md §2 requires 08xx / 62xx / +62xx to collapse to
 * one canonical E.164 value, so `phone` holds the canonical one and `raw` keeps
 * what actually came off the page.
 */
export function mobileNumber(rng: () => number): { raw: string; e164: string } {
  const prefixes = ['811', '812', '813', '821', '822', '852', '853', '857', '878']
  const prefix = pick(rng, prefixes)
  const rest = String(intBetween(rng, 1000000, 9999999))
  return { raw: `0${prefix}${rest}`, e164: `+62${prefix}${rest}` }
}

export function landline(rng: () => number, areaCode: string): string {
  return `+62${areaCode}${String(intBetween(rng, 1000000, 8999999)).slice(0, 7)}`
}
