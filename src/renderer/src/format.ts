// Locale-aware formatting for the note list and the sidebar.
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

/** The time for notes updated today, the date otherwise (`now` may be any time of today). */
export function noteDate(updatedAt: number, now: number, locale: string): string {
  const date = new Date(updatedAt)
  const today = sameDay(date, new Date(now))
  return kept(
    `date|${today ? 'time' : 'day'}|${locale}`,
    () => new Intl.DateTimeFormat(locale, today ? { timeStyle: 'short' } : { dateStyle: 'medium' }),
  ).format(date)
}

/**
 * How long since a note changed, as the list shows it: "a few seconds",
 * "7 minutes", "3 hours", "3 days"; a month or more back, its date.
 */
export function relativeTime(updatedAt: number, now: number, locale: string): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  const span = (count: number, unit: 'minute' | 'hour' | 'day') =>
    kept(
      `span|${unit}|${locale}`,
      () => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }),
    ).format(count)
  if (seconds < 60) return t('time.fewSeconds')
  if (seconds < 3600) return span(Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return span(Math.floor(seconds / 3600), 'hour')
  const days = Math.floor(seconds / 86_400)
  if (days < 30) return span(days, 'day')
  return noteDate(updatedAt, now, locale)
}

/** A note's date and time in full, for tooltips. */
export function fullDate(updatedAt: number, locale: string): string {
  return kept(
    `date|full|${locale}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
  ).format(new Date(updatedAt))
}

/** A count with the catalog's plural form for the locale ("1 note", "12 notes"). */
export function countOf(count: number, locale: string, one: MessageKey, other: MessageKey): string {
  const plural = kept(`plural|${locale}`, () => new Intl.PluralRules(locale))
  const key = plural.select(count) === 'one' ? one : other
  const number = kept(`number|${locale}`, () => new Intl.NumberFormat(locale))
  return format(t(key), { count: number.format(count) })
}

/** Task progress in the note info card: "1 of 2 tasks". */
export function taskCount(done: number, total: number, locale: string): string {
  const plural = kept(`plural|${locale}`, () => new Intl.PluralRules(locale))
  const key = plural.select(total) === 'one' ? 'noteInfo.tasksOne' : 'noteInfo.tasksOther'
  const number = kept(`number|${locale}`, () => new Intl.NumberFormat(locale))
  return format(t(key), { done: number.format(done), count: number.format(total) })
}

const pad = (value: number) => String(value).padStart(2, '0')

/** A note's date in the note info card, in local time: `YYYY-MM-DD HH:mm:ss`. */
export function stampDate(at: number): string {
  const d = new Date(at)
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const noteCount = (count: number, locale: string) =>
  countOf(count, locale, 'noteList.countOne', 'noteList.countOther')

/** The list's count line: "12 notes", or "<scope> \u00b7 12 notes" for a scoped view. */
export function listCaption(count: number, scope: string | undefined, locale: string): string {
  const notes = noteCount(count, locale)
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

/** "250 kB", "12.3 MB", "2.3 GB" (decimal units, as Finder shows them); nothing is "0 kB". */
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
