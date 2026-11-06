import { DAY_MS } from '../../core/activity'

/** A day number (see core/activity.ts) as a date; day numbers count UTC days. */
export const dateOf = (day: number, locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(day * DAY_MS)

/**
 * Month names over the weeks where a month starts, the current month's included; the first
 * week is labelled unless the next label is too close. A name in the last week ends at the
 * grid's edge (the heatmaps' CSS), so it never runs past it.
 */
export function monthLabels(first: number, weeks: number, locale: string): string[] {
  const month = (week: number) => new Date((first + week * 7) * DAY_MS).getUTCMonth()
  const labels = Array.from({ length: weeks }, (_, week) =>
    week > 0 && month(week) !== month(week - 1)
      ? dateOf(first + week * 7, locale, { month: 'short' })
      : '',
  )
  if (labels.slice(1, 3).every((label) => label === '')) {
    labels[0] = dateOf(first, locale, { month: 'short' })
  }
  return labels
}
