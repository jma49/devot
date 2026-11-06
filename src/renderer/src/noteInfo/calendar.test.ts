import { describe, expect, it } from 'vitest'
import {
  addMonths,
  boundsFor,
  dayAllowed,
  dayKeyMove,
  monthGrid,
  pendingAt,
  pendingOf,
  pendingProblem,
  setDayPeriod,
  shownHour,
  stepSegment,
  typeSegment,
  usesDayPeriod,
  weekStartOf,
  type Day,
  type Pending,
} from './calendar'

const day = (year: number, month: number, d: number): Day => ({ year, month, day: d })
const at = (...parts: [number, number, number, number?, number?, number?]) =>
  new Date(...(parts as [number, number, number, number, number, number])).getTime()

const info = { createdAt: at(2026, 9, 13, 1, 43, 54), updatedAt: at(2026, 10, 2, 9, 30, 0) }

describe('the month grid', () => {
  const marks = { today: day(2026, 10, 6), selected: day(2026, 10, 2), bounds: {} }

  it('shows six weeks from the week holding the 1st, on the locale’s first weekday', () => {
    // November 2026 starts on a Sunday.
    const sunday = monthGrid({ year: 2026, month: 10 }, 0, marks)
    expect(sunday).toHaveLength(42)
    expect(sunday[0]).toMatchObject({ year: 2026, month: 10, day: 1, outside: false })
    expect(sunday[41]).toMatchObject({ year: 2026, month: 11, day: 12, outside: true })
    const monday = monthGrid({ year: 2026, month: 10 }, 1, marks)
    expect(monday[0]).toMatchObject({ year: 2026, month: 9, day: 26, outside: true })
    expect(monday[6]).toMatchObject({ month: 10, day: 1, outside: false })
  })

  it('marks today and the chosen day', () => {
    const grid = monthGrid({ year: 2026, month: 10 }, 0, marks)
    expect(grid.filter((c) => c.today).map((c) => c.day)).toEqual([6])
    expect(grid.filter((c) => c.selected).map((c) => c.day)).toEqual([2])
  })

  it('crosses the year at both ends', () => {
    const january = monthGrid({ year: 2027, month: 0 }, 0, marks)
    expect(january[0]).toMatchObject({ year: 2026, month: 11, day: 27, outside: true })
    expect(january.find((c) => !c.outside)).toMatchObject({ year: 2027, month: 0, day: 1 })
  })

  it('turns off the days the rules leave out, keeping the boundary day', () => {
    const created = monthGrid({ year: 2026, month: 10 }, 0, {
      ...marks,
      bounds: boundsFor('created', info),
    })
    expect(created.find((c) => c.month === 10 && c.day === 2)?.disabled).toBe(false)
    expect(created.find((c) => c.month === 10 && c.day === 3)?.disabled).toBe(true)
    const updated = monthGrid({ year: 2026, month: 9 }, 0, {
      ...marks,
      bounds: boundsFor('updated', info),
    })
    expect(updated.find((c) => c.month === 9 && c.day === 12)?.disabled).toBe(true)
    expect(updated.find((c) => c.month === 9 && c.day === 13)?.disabled).toBe(false)
  })

  it('allows no day before 1970 for Created', () => {
    expect(dayAllowed(day(1969, 11, 30), boundsFor('created', info))).toBe(false)
  })
})

describe('the grid’s keys', () => {
  const from = day(2026, 0, 31)

  it('moves by a day, a week, a month and a year', () => {
    expect(dayKeyMove(from, 'ArrowLeft', 0)).toEqual(day(2026, 0, 30))
    expect(dayKeyMove(from, 'ArrowRight', 0)).toEqual(day(2026, 1, 1))
    expect(dayKeyMove(from, 'ArrowUp', 0)).toEqual(day(2026, 0, 24))
    expect(dayKeyMove(from, 'ArrowDown', 0)).toEqual(day(2026, 1, 7))
    expect(dayKeyMove(from, 'PageDown', 0)).toEqual(day(2026, 1, 28))
    expect(dayKeyMove(from, 'PageUp', 0)).toEqual(day(2025, 11, 31))
    expect(dayKeyMove(day(2024, 1, 29), 'PageDown', 0, true)).toEqual(day(2025, 1, 28))
    expect(dayKeyMove(from, 'Enter', 0)).toBeUndefined()
  })

  it('goes to the ends of the week the locale starts', () => {
    // 31 January 2026 is a Saturday.
    expect(dayKeyMove(from, 'Home', 0)).toEqual(day(2026, 0, 25))
    expect(dayKeyMove(from, 'End', 0)).toEqual(from)
    expect(dayKeyMove(from, 'Home', 1)).toEqual(day(2026, 0, 26))
    expect(dayKeyMove(from, 'End', 1)).toEqual(day(2026, 1, 1))
  })

  it('keeps the day in a shorter month', () => {
    expect(addMonths(day(2026, 2, 31), -1)).toEqual(day(2026, 1, 28))
  })
})

describe('the time segments', () => {
  const pending = (hour: number | null, minute: number | null = 5): Pending => ({
    day: day(2026, 10, 2),
    hour,
    minute,
    second: 42,
  })

  it('steps and wraps the hour and the minute', () => {
    expect(stepSegment(pending(23), 'hour', 1, false).hour).toBe(0)
    expect(stepSegment(pending(0), 'hour', -1, false).hour).toBe(23)
    expect(stepSegment(pending(1, 59), 'minute', 1, false).minute).toBe(0)
    expect(stepSegment(pending(1, 0), 'minute', -1, false).minute).toBe(59)
  })

  it('keeps AM or PM while stepping a 12-hour clock, and flips it on its own segment', () => {
    expect(stepSegment(pending(11), 'hour', 1, true).hour).toBe(0)
    expect(stepSegment(pending(23), 'hour', 1, true).hour).toBe(12)
    expect(stepSegment(pending(12), 'hour', -1, true).hour).toBe(23)
    expect(stepSegment(pending(9), 'dayPeriod', 1, true).hour).toBe(21)
    expect(setDayPeriod(pending(21), false).hour).toBe(9)
    expect(setDayPeriod(pending(9), false).hour).toBe(9)
    expect([0, 9, 12, 21].map((h) => shownHour(h, true))).toEqual([12, 9, 12, 9])
    expect(shownHour(21, false)).toBe(21)
  })

  it('takes typed digits, two at most, and says when the segment is full', () => {
    const one = typeSegment(pending(9), 'minute', '', '3', false)
    expect(one).toMatchObject({ pending: { minute: 3 }, typed: '3', done: false })
    const two = typeSegment(one.pending, 'minute', one.typed, '7', false)
    expect(two).toMatchObject({ pending: { minute: 37 }, typed: '37', done: true })
    expect(typeSegment(pending(9), 'minute', '', '7', false)).toMatchObject({ done: true })
    expect(typeSegment(pending(9), 'minute', '6', '1', false)).toMatchObject({
      pending: { minute: 1 },
      typed: '1',
    })
    expect(typeSegment(pending(9), 'hour', '2', '3', false).pending.hour).toBe(23)
    expect(typeSegment(pending(9), 'hour', '2', '5', false).pending.hour).toBe(5)
  })

  it('types a 12-hour clock’s hour in its own half of the day', () => {
    expect(typeSegment(pending(15), 'hour', '', '4', true).pending.hour).toBe(16)
    expect(typeSegment(pending(15), 'hour', '1', '2', true).pending.hour).toBe(12)
    expect(typeSegment(pending(3), 'hour', '1', '2', true).pending.hour).toBe(0)
    expect(typeSegment(pending(3), 'hour', '', '0', true).pending.hour).toBeNull()
  })

  it('keeps the seconds it never shows', () => {
    const start = at(2026, 10, 2, 9, 30, 42)
    expect(pendingAt(pendingOf(start))).toBe(start)
    expect(pendingAt(pending(null))).toBeNull()
  })
})

describe('what Set refuses', () => {
  const of = (time: number): Pending => pendingOf(time)

  it('a cleared hour or minute', () => {
    expect(pendingProblem('created', { ...of(info.createdAt), minute: null }, info)).toBe(
      'noteInfo.dateIncomplete',
    )
  })

  it('Created after Updated, and Updated before Created', () => {
    expect(pendingProblem('created', of(info.updatedAt + 1000), info)).toBe(
      'noteInfo.createdTooLate',
    )
    expect(pendingProblem('updated', of(info.createdAt - 1000), info)).toBe(
      'noteInfo.updatedTooEarly',
    )
  })

  it('nothing for dates that keep the order, equal ones included', () => {
    expect(pendingProblem('created', of(info.updatedAt), info)).toBeUndefined()
    expect(pendingProblem('updated', of(info.createdAt), info)).toBeUndefined()
    expect(pendingProblem('updated', of(at(2030, 0, 1)), info)).toBeUndefined()
  })
})

describe('the locale’s calendar', () => {
  it('starts the week where the locale does', () => {
    expect(weekStartOf('en-US')).toBe(0)
    expect(weekStartOf('en-GB')).toBe(1)
    expect(weekStartOf('not a locale')).toBe(0)
  })

  it('writes AM and PM where the locale does', () => {
    expect(usesDayPeriod('en-US')).toBe(true)
    expect(usesDayPeriod('en-GB')).toBe(false)
  })
})
