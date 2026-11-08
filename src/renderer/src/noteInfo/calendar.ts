// The Note Info card's date picker (DatePicker.tsx): its month grid, keys, time segments and rules.
import type { MessageKey } from '../i18n'
import { datesEdit, type NoteInfoData } from './infoCard'

export interface Day {
  year: number
  /** 0 for January. */
  month: number
  day: number
}

export type DateField = 'created' | 'updated'

/**
 * The date being chosen. A cleared hour or minute is null; AM or PM outlives a cleared hour.
 * `from` is the date the picker opened on: its seconds and milliseconds are kept and never shown.
 */
export interface Pending {
  day: Day
  /** 0 to 11: the hours since midnight, or since noon when `pm`. */
  hourInHalf: number | null
  pm: boolean
  minute: number | null
  from: number
}

export interface DateBounds {
  min?: number
  max?: number
}

export interface DayCell extends Day {
  outside: boolean
  today: boolean
  selected: boolean
  disabled: boolean
}

export type Segment = 'hour' | 'minute' | 'dayPeriod'

export const GRID_DAYS = 42

const local = (d: Day, plusDays = 0) => new Date(d.year, d.month, d.day + plusDays)

const dayFromDate = (date: Date): Day => ({
  year: date.getFullYear(),
  month: date.getMonth(),
  day: date.getDate(),
})

export const dayOf = (at: number): Day => dayFromDate(new Date(at))

export const sameDay = (a: Day, b: Day) =>
  a.year === b.year && a.month === b.month && a.day === b.day

export const addDays = (d: Day, n: number): Day => dayFromDate(local(d, n))

/** The same day `n` months on, or the month's last day when it has fewer. */
export function addMonths(d: Day, n: number): Day {
  const first = new Date(d.year, d.month + n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return { year: first.getFullYear(), month: first.getMonth(), day: Math.min(d.day, last) }
}

/** The hour from 0 to 23; null while it is cleared. */
export const hourOf = (pending: Pending) =>
  pending.hourInHalf === null ? null : pending.hourInHalf + (pending.pm ? 12 : 0)

const withHour = (pending: Pending, hour: number): Pending => ({
  ...pending,
  hourInHalf: hour % 12,
  pm: hour >= 12,
})

export function pendingOf(at: number): Pending {
  const date = new Date(at)
  const hour = date.getHours()
  return {
    day: dayFromDate(date),
    hourInHalf: hour % 12,
    pm: hour >= 12,
    minute: date.getMinutes(),
    from: at,
  }
}

const sameFields = (a: Pending, b: Pending) =>
  sameDay(a.day, b.day) && hourOf(a) === hourOf(b) && a.minute === b.minute

/**
 * The time `pending` names in local time; null while its hour or minute is cleared, or when the
 * clocks skip it. Unchanged, it is `from` itself, even in the repeated hour when the clocks go back.
 */
export function pendingAt(pending: Pending): number | null {
  const { day, minute, from } = pending
  const hour = hourOf(pending)
  if (hour === null || minute === null) return null
  if (sameFields(pending, pendingOf(from))) return from
  const kept = new Date(from)
  const date = new Date(
    day.year,
    day.month,
    day.day,
    hour,
    minute,
    kept.getSeconds(),
    kept.getMilliseconds(),
  )
  return sameFields(pending, pendingOf(date.getTime())) ? date.getTime() : null
}

/** Created may not come after Updated, and Updated may not come before Created. */
export function boundsFor(field: DateField, info: Pick<NoteInfoData, 'createdAt' | 'updatedAt'>) {
  return field === 'created' ? { min: 0, max: info.updatedAt } : { min: info.createdAt }
}

/** Whether some time of day `d` is inside `bounds`. */
export function dayAllowed(d: Day, bounds: DateBounds): boolean {
  const start = local(d).getTime()
  const end = local(d, 1).getTime() - 1
  return (
    (bounds.min === undefined || end >= bounds.min) &&
    (bounds.max === undefined || start <= bounds.max)
  )
}

/** Six weeks from the week holding the 1st of `view`'s month, starting on `weekStart` (0 is Sunday). */
export function monthGrid(
  view: Pick<Day, 'year' | 'month'>,
  weekStart: number,
  marks: { today: Day; selected: Day; bounds: DateBounds },
): DayCell[] {
  const first: Day = { year: view.year, month: view.month, day: 1 }
  const lead = (local(first).getDay() - weekStart + 7) % 7
  return Array.from({ length: GRID_DAYS }, (_, i) => {
    const d = addDays(first, i - lead)
    return {
      ...d,
      outside: d.month !== view.month || d.year !== view.year,
      today: sameDay(d, marks.today),
      selected: sameDay(d, marks.selected),
      disabled: !dayAllowed(d, marks.bounds),
    }
  })
}

/** The locale's first day of the week, 0 for Sunday; Sunday where the engine cannot tell. */
export function weekStartOf(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay
    return firstDay === undefined ? 0 : firstDay % 7
  } catch {
    return 0
  }
}

/** Where a key moves the focused day of the grid: by a day, a week, a month (a year with Shift), or to the week's ends. */
export function dayKeyMove(d: Day, key: string, weekStart: number, shift = false): Day | undefined {
  const inWeek = (local(d).getDay() - weekStart + 7) % 7
  switch (key) {
    case 'ArrowLeft':
      return addDays(d, -1)
    case 'ArrowRight':
      return addDays(d, 1)
    case 'ArrowUp':
      return addDays(d, -7)
    case 'ArrowDown':
      return addDays(d, 7)
    case 'PageUp':
      return addMonths(d, shift ? -12 : -1)
    case 'PageDown':
      return addMonths(d, shift ? 12 : 1)
    case 'Home':
      return addDays(d, -inWeek)
    case 'End':
      return addDays(d, 6 - inWeek)
    default:
      return undefined
  }
}

/** Why Set cannot save `pending` as `field`'s date; undefined when it can. */
export function pendingProblem(
  field: DateField,
  pending: Pending,
  info: Pick<NoteInfoData, 'createdAt' | 'updatedAt'>,
): MessageKey | undefined {
  if (pending.hourInHalf === null || pending.minute === null) return 'noteInfo.dateIncomplete'
  const at = pendingAt(pending)
  if (at === null) return 'noteInfo.timeSkipped'
  if (at < 0) return 'noteInfo.dateIncomplete'
  if (datesEdit(info, field, at)) return undefined
  return field === 'created' ? 'noteInfo.createdTooLate' : 'noteInfo.updatedTooEarly'
}

/** Whether the locale writes the hour from 1 to 12 with AM and PM. */
export function usesDayPeriod(locale: string): boolean {
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
  return cycle === 'h11' || cycle === 'h12'
}

export const shownHour = (hour: number, dayPeriod: boolean) => (dayPeriod ? hour % 12 || 12 : hour)

const wrap = (n: number, size: number) => ((n % size) + size) % size

/** Up and Down Arrow on a segment; the hour of a 12-hour clock keeps its AM or PM. */
export function stepSegment(
  pending: Pending,
  segment: Segment,
  by: number,
  dayPeriod: boolean,
): Pending {
  if (segment === 'minute') return { ...pending, minute: wrap((pending.minute ?? 0) + by, 60) }
  if (segment === 'dayPeriod') return { ...pending, pm: !pending.pm }
  if (!dayPeriod) return withHour(pending, wrap((hourOf(pending) ?? 0) + by, 24))
  return { ...pending, hourInHalf: wrap((pending.hourInHalf ?? 0) + by, 12) }
}

/**
 * A digit typed into the hour or minute: it joins the one typed before while the two make a value
 * the segment can hold. `done` says the segment can take no more, so the next one is focused.
 */
export function typeSegment(
  pending: Pending,
  segment: 'hour' | 'minute',
  typed: string,
  digit: string,
  dayPeriod: boolean,
): { pending: Pending; typed: string; done: boolean } {
  const [low, high] = segment === 'minute' ? [0, 59] : dayPeriod ? [1, 12] : [0, 23]
  let next = typed + digit
  if (next.length > 2 || Number(next) > high) next = digit
  const value = Number(next)
  const done = next.length === 2 || value * 10 > high
  const field = segment === 'minute' ? 'minute' : 'hourInHalf'
  if (value < low) return { pending: { ...pending, [field]: null }, typed: next, done }
  if (segment === 'minute') return { pending: { ...pending, minute: value }, typed: next, done }
  const typedHour = dayPeriod ? { ...pending, hourInHalf: value % 12 } : withHour(pending, value)
  return { pending: typedHour, typed: next, done }
}

/** A or P typed into the AM/PM segment, with or without an hour. */
export function setDayPeriod(pending: Pending, pm: boolean): Pending {
  return pending.pm === pm ? pending : { ...pending, pm }
}
