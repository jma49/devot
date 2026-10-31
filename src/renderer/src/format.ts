import { currentLocale, format, t, type MessageKey } from './i18n'

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

// Formatters are costly to build, and a list formats a date per row: each
// is built once per locale and kind, then kept.
const formatters = new Map<
  string,
  Intl.DateTimeFormat | Intl.PluralRules | Intl.NumberFormat | Intl.RelativeTimeFormat
>()

function kept<
  T extends Intl.DateTimeFormat | Intl.PluralRules | Intl.NumberFormat | Intl.RelativeTimeFormat,
>(key: string, build: () => T): T {
  let formatter = formatters.get(key) as T | undefined
  if (!formatter) {
    formatter = build()
    formatters.set(key, formatter)
  }
  return formatter
}

/**
 * The local time zone's offsets in winter and summer: a date formatter keeps the zone it was built
 * in, so one built before the Mac moved to another zone is not used after.
 */
function zone(): string {
  const year = new Date().getFullYear()
  return `${new Date(year, 0, 1).getTimezoneOffset()}/${new Date(year, 6, 1).getTimezoneOffset()}`
}

export function noteDate(updatedAt: number, now: number, locale: string): string {
  const date = new Date(updatedAt)
  const today = sameDay(date, new Date(now))
  return kept(
    `date|${today ? 'time' : 'day'}|${locale}|${zone()}`,
    () => new Intl.DateTimeFormat(locale, today ? { timeStyle: 'short' } : { dateStyle: 'medium' }),
  ).format(date)
}

export function relativeTime(updatedAt: number, now: number, locale: string): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  const span = (count: number, unit: 'minute' | 'hour' | 'day') =>
    format(t('time.ago'), {
      time: kept(
        `span|${unit}|${locale}`,
        () => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }),
      ).format(count),
    })
  if (seconds < 60) return t('time.justNow')
  if (seconds < 3600) return span(Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return span(Math.floor(seconds / 3600), 'hour')
  const days = Math.floor(seconds / 86_400)
  if (days < 30) return span(days, 'day')
  return noteDate(updatedAt, now, locale)
}

export function rowDate(
  at: number,
  now: number,
  locale: string,
  style: 'relative' | 'absolute',
): string {
  return style === 'absolute' ? noteDate(at, now, locale) : relativeTime(at, now, locale)
}

export function fullDate(updatedAt: number, locale: string): string {
  return kept(
    `date|full|${locale}|${zone()}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
  ).format(new Date(updatedAt))
}

export function exactDate(at: number, locale: string): string {
  return kept(
    `date|exact|${locale}|${zone()}`,
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
  ).format(new Date(at))
}

export function countOf(count: number, locale: string, one: MessageKey, other: MessageKey): string {
  const plural = kept(`plural|${locale}`, () => new Intl.PluralRules(locale))
  const key = plural.select(count) === 'one' ? one : other
  const number = kept(`number|${locale}`, () => new Intl.NumberFormat(locale))
  return format(t(key), { count: number.format(count) })
}

export function formatNumber(count: number, locale: string): string {
  return kept(`number|${locale}`, () => new Intl.NumberFormat(locale)).format(count)
}

export function taskCount(done: number, total: number, locale: string): string {
  const plural = kept(`plural|${locale}`, () => new Intl.PluralRules(locale))
  const key = plural.select(total) === 'one' ? 'noteInfo.tasksOne' : 'noteInfo.tasksOther'
  const number = kept(`number|${locale}`, () => new Intl.NumberFormat(locale))
  return format(t(key), { done: number.format(done), count: number.format(total) })
}

export const noteCount = (count: number, locale: string) =>
  countOf(count, locale, 'noteList.countOne', 'noteList.countOther')

export function listCaption(
  count: number,
  scope: string | undefined,
  locale: string,
  capped = false,
): string {
  const notes = capped
    ? format(t('noteList.capped'), {
        count: kept(`number|${locale}`, () => new Intl.NumberFormat(locale)).format(count),
      })
    : noteCount(count, locale)
  return scope ? format(t('noteList.scopedCount'), { scope, notes }) : notes
}

/**
 * What deleting a notebook takes and leaves, for the question that asks first:
 * its `subs` sub-notebooks go with it; the `notes` in it and them stay, in
 * no notebook.
 */
export function bookDeleteDetail(subs: number, notes: number): string {
  const locale = currentLocale()
  const subCount = countOf(subs, locale, 'book.subOne', 'book.subOther')
  if (subs === 0) {
    return notes === 0
      ? t('book.deleteEmpty')
      : format(t('book.deleteNotes'), { notes: noteCount(notes, locale) })
  }
  return notes === 0
    ? format(t('book.deleteSubs'), { subs: subCount })
    : format(t('book.deleteSubsNotes'), {
        subs: subCount,
        notes: noteCount(notes, locale),
      })
}

export function fileSize(bytes: number, locale: string): string {
  const [value, unit] =
    bytes < 1_000_000
      ? [bytes / 1000, 'kilobyte']
      : bytes < 1_000_000_000
        ? [bytes / 1_000_000, 'megabyte']
        : [bytes / 1_000_000_000, 'gigabyte']
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'kilobyte' ? 0 : 1,
  }).format(bytes <= 0 ? 0 : Math.max(value, unit === 'kilobyte' ? 1 : 0))
}

/** A day number (core/activity.ts counts UTC days of local dates) as a medium date. */
export function dayDate(day: number, locale: string): string {
  return kept(
    `dayDate|${locale}`,
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
  ).format(day * 86_400_000)
}

/** When a sync pause ends: the time today, or with the weekday when that is another day here. */
export function untilTime(at: number, now: number, locale: string): string {
  const today = sameDay(new Date(at), new Date(now))
  return kept(
    `until|${today ? 'time' : 'weekday'}|${locale}`,
    () =>
      new Intl.DateTimeFormat(
        locale,
        today ? { timeStyle: 'short' } : { weekday: 'long', hour: 'numeric', minute: '2-digit' },
      ),
  ).format(at)
}

/** A sync upload's progress: `sent` and `total` as numbers of the locale. */
export function uploadCounts(
  upload: { sent: number; total: number },
  locale: string,
): { sent: string; total: string } {
  const number = kept(`number|${locale}`, () => new Intl.NumberFormat(locale))
  return { sent: number.format(upload.sent), total: number.format(upload.total) }
}
