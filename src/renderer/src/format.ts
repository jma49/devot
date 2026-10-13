// Locale-aware formatting for the note list and the sidebar.
import { currentLocale, format, t, type MessageKey } from './i18n'

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

// Formatters are costly to build, and a list formats a date per row: each
// is built once per locale and kind, then kept.
const formatters = new Map<string, Intl.DateTimeFormat | Intl.PluralRules | Intl.NumberFormat>()

function kept<T extends Intl.DateTimeFormat | Intl.PluralRules | Intl.NumberFormat>(
  key: string,
  build: () => T,
): T {
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

/** A count with the catalog's plural form for the locale ("1 note", "12 notes"). */
export function countOf(count: number, locale: string, one: MessageKey, other: MessageKey): string {
  const plural = kept(`plural|${locale}`, () => new Intl.PluralRules(locale))
  const key = plural.select(count) === 'one' ? one : other
  const number = kept(`number|${locale}`, () => new Intl.NumberFormat(locale))
  return format(t(key), { count: number.format(count) })
}

export const noteCount = (count: number, locale: string) =>
  countOf(count, locale, 'noteList.countOne', 'noteList.countOther')

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
    : format(t('book.deleteSubsNotes'), { subs: subCount, notes: noteCount(notes, locale) })
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
