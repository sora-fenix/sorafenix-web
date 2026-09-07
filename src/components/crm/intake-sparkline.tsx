import type { IntakeDay } from '@/lib/db/queries/dashboard'
import { formatDayShort, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Daily new-lead bars for the dashboard intake card.
 *
 * Presentational and server-rendered — no `'use client'`. The numbers arrive
 * already bucketed from `getDailyIntake`; this decides nothing.
 *
 * Days with no run render as a visible empty column rather than being skipped.
 * A gap in the sweep is information (the machine was asleep, or the n8n workflow
 * was not Active), and a chart that closes the gap would hide it.
 */
export function IntakeSparkline({ days }: { days: readonly IntakeDay[] }) {
  const max = Math.max(...days.map((d) => d.count), 1)
  const today = days.at(-1)?.day

  return (
    <div className="flex items-end gap-1.5" aria-hidden="false">
      {days.map((day) => {
        const isToday = day.day === today
        const height = day.count === 0 ? 2 : Math.max(8, (day.count / max) * 100)

        return (
          <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="text-muted-foreground text-[10px] leading-none tabular-nums">
              {day.count === 0 ? '' : formatNumber(day.count)}
            </span>
            <div className="flex h-16 w-full items-end">
              <div
                className={cn(
                  'w-full rounded-sm',
                  day.count === 0
                    ? 'bg-muted'
                    : isToday
                      ? 'bg-primary'
                      : 'bg-primary/45',
                )}
                style={{ height: `${height}%` }}
                title={`${day.day}: ${formatNumber(day.count)} prospek baru`}
              />
            </div>
            <span
              className={cn(
                'text-[10px] leading-none',
                isToday ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              {formatDayShort(day.day)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
