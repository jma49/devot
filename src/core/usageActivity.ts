import { DAY_MS, localDay, systemOffset, weekday, type OffsetAt } from './activity'
import { usageCounts, type StoredUsageEvent } from './usage'

export type UsagePeriod = 7 | 30 | 90

export function usageActivity(
  events: readonly StoredUsageEvent[],
  now: number,
  period: UsagePeriod,
  name = '',
  offsetAt: OffsetAt = systemOffset,
) {
  const today = localDay(now, offsetAt)
  const first = today - period + 1
  const days = Array.from({ length: period }, (_, i) => ({ day: first + i, count: 0 }))
  const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  const selected: StoredUsageEvent[] = []
  for (const event of events) {
    if (!Number.isFinite(event.at) || event.at > now || (name && event.name !== name)) continue
    const day = localDay(event.at, offsetAt)
    if (day < first || day > today) continue
    const hour = new Date(event.at + offsetAt(event.at) * 60_000).getUTCHours()
    days[day - first]!.count++
    const row = hours[weekday(day)]!
    row[hour] = row[hour]! + 1
    selected.push(event)
  }
  const counts = usageCounts(selected)
  let peak: { weekday: number; hour: number; count: number } | null = null
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    for (let hour = 0; hour < 24; hour++) {
      const count = hours[dayIndex]![hour]!
      if (count > (peak?.count ?? 0)) peak = { weekday: dayIndex, hour, count }
    }
  }
  return {
    first,
    today,
    days,
    hours,
    counts,
    peak,
    total: selected.length,
    notes: counts.find((row) => row.name === 'note.created')?.count ?? 0,
    activeDays: days.filter((day) => day.count > 0).length,
    average: selected.length / period,
  }
}

export const usageDayInstant = (day: number) => day * DAY_MS
