/**
 * Indonesian formatting helpers. Dates render in Asia/Jakarta so a figure never
 * shifts a day depending on where the server runs.
 */

const TIME_ZONE = 'Asia/Jakarta'

const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: TIME_ZONE,
})

const dateTimeFormatter = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: TIME_ZONE,
})

const numberFormatter = new Intl.NumberFormat('id-ID')

// Always one decimal, so a column of ratings lines up: 5 reads as "5,0" beside
// "4,7" rather than jumping a character width.
const ratingFormatter = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TIME_ZONE,
})

// A calendar date already in Jakarta terms, so it is read back in UTC — shifting
// it a second time would move a Monday to a Sunday for anyone west of Jakarta.
const weekdayFormatter = new Intl.DateTimeFormat('id-ID', {
  weekday: 'short',
  timeZone: 'UTC',
})

export function formatDate(value: Date | null): string {
  if (value === null) return '—'
  return dateFormatter.format(value)
}

export function formatDateTime(value: Date | null): string {
  if (value === null) return '—'
  return dateTimeFormatter.format(value)
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value)
}

/** A Google Maps rating in Indonesian notation: 4.7 renders as "4,7". */
export function formatRating(value: number): string {
  return ratingFormatter.format(value)
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace('.', ',')}%`
}

/**
 * "YYYY-MM-DD" for the day an instant falls on in Jakarta.
 *
 * This is the key daily figures are bucketed by, so the same instant always
 * lands on the same bar no matter where the server runs. Postgres does the same
 * bucketing with `at time zone 'Asia/Jakarta'`; the two must agree.
 */
export function jakartaDayKey(value: Date): string {
  return dayKeyFormatter.format(value)
}

/** "Sen" / "Sel" … for a key produced by `jakartaDayKey`. */
export function formatDayShort(dayKey: string): string {
  return weekdayFormatter.format(new Date(`${dayKey}T00:00:00Z`))
}

/** "3 hari lagi" / "2 hari lalu" / "Hari ini", relative to today in Jakarta. */
export function formatRelativeDay(value: Date | null): string {
  if (value === null) return '—'

  const startOfDay = (d: Date): number => Date.parse(`${jakartaDayKey(d)}T00:00:00Z`)

  const days = Math.round((startOfDay(value) - startOfDay(new Date())) / 86_400_000)

  if (days === 0) return 'Hari ini'
  if (days === 1) return 'Besok'
  if (days === -1) return 'Kemarin'
  if (days > 1) return `${days} hari lagi`
  return `${Math.abs(days)} hari lalu`
}

/** True when a follow-up is overdue, so the UI can flag it. */
export function isOverdue(value: Date | null): boolean {
  if (value === null) return false
  return value.getTime() < Date.now()
}

export function truncate(value: string | null, max: number): string {
  if (value === null) return '—'
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}
