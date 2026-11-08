import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMonths,
  boundsFor,
  dayAllowed,
  dayKeyMove,
  hourOf,
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
const at = (...parts: [number, number, number, number?, number?, number?, number?]) =>
  new Date(...(parts as [number, number, number, number, number, number, number])).getTime()

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
    hourInHalf: hour === null ? null : hour % 12,
    pm: hour !== null && hour >= 12,
    minute,
    from: at(2026, 10, 2, 9, 5, 42),
  })
  const cleared = (hour: number) => ({ ...pending(hour), hourInHalf: null })

  it('steps and wraps the hour and the minute', () => {
    expect(hourOf(stepSegment(pending(23), 'hour', 1, false))).toBe(0)
    expect(hourOf(stepSegment(pending(0), 'hour', -1, false))).toBe(23)
    expect(stepSegment(pending(1, 59), 'minute', 1, false).minute).toBe(0)
    expect(stepSegment(pending(1, 0), 'minute', -1, false).minute).toBe(59)
  })

  it('keeps AM or PM while stepping a 12-hour clock, and flips it on its own segment', () => {
    expect(hourOf(stepSegment(pending(11), 'hour', 1, true))).toBe(0)
    expect(hourOf(stepSegment(pending(23), 'hour', 1, true))).toBe(12)
    expect(hourOf(stepSegment(pending(12), 'hour', -1, true))).toBe(23)
    expect(hourOf(stepSegment(pending(9), 'dayPeriod', 1, true))).toBe(21)
    expect(hourOf(setDayPeriod(pending(21), false))).toBe(9)
    expect(hourOf(setDayPeriod(pending(9), false))).toBe(9)
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
    expect(hourOf(typeSegment(pending(9), 'hour', '2', '3', false).pending)).toBe(23)
    expect(hourOf(typeSegment(pending(9), 'hour', '2', '5', false).pending)).toBe(5)
  })

  it('types a 12-hour clock’s hour in its own half of the day', () => {
    expect(hourOf(typeSegment(pending(15), 'hour', '', '4', true).pending)).toBe(16)
    expect(hourOf(typeSegment(pending(15), 'hour', '1', '2', true).pending)).toBe(12)
    expect(hourOf(typeSegment(pending(3), 'hour', '1', '2', true).pending)).toBe(0)
    expect(hourOf(typeSegment(pending(3), 'hour', '', '0', true).pending)).toBeNull()
  })

  it('keeps PM while the hour of a 12-hour clock is cleared or retyped', () => {
    expect(hourOf(typeSegment(cleared(15), 'hour', '', '3', true).pending)).toBe(15)
    const zero = typeSegment(pending(15), 'hour', '', '0', true)
    expect(hourOf(typeSegment(zero.pending, 'hour', zero.typed, '5', true).pending)).toBe(17)
    const chosen = setDayPeriod(cleared(3), true)
    expect(hourOf(typeSegment(chosen, 'hour', '', '3', true).pending)).toBe(15)
  })

  it('keeps the seconds and milliseconds it never shows', () => {
    const start = at(2026, 10, 2, 9, 30, 42, 700)
    expect(pendingAt(pendingOf(start))).toBe(start)
    expect(pendingAt({ ...pendingOf(start), minute: 31 })).toBe(start + 60_000)
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

  it('nothing for an unchanged date that shares its second with the other one', () => {
    const now = at(2026, 9, 13, 1, 43, 54, 700)
    const fresh = { createdAt: now, updatedAt: now }
    expect(pendingProblem('updated', of(fresh.updatedAt), fresh)).toBeUndefined()
    expect(pendingProblem('created', of(fresh.createdAt), fresh)).toBeUndefined()
  })
})

describe('the clock changes', () => {
  const zone = process.env['TZ']
  beforeAll(() => {
    process.env['TZ'] = 'America/New_York'
  })
  afterAll(() => {
    if (zone === undefined) delete process.env['TZ']
    else process.env['TZ'] = zone
  })

  it('refuses a time the clocks skip', () => {
    // On 8 March 2026 New York's clocks go from 02:00 to 03:00.
    const skipped: Pending = { ...pendingOf(at(2026, 2, 8, 1, 30)), hourInHalf: 2, minute: 30 }
    expect(pendingAt(skipped)).toBeNull()
    expect(pendingProblem('updated', skipped, { createdAt: 0, updatedAt: 0 })).toBe(
      'noteInfo.timeSkipped',
    )
  })

  it('writes back the second of two equal times unchanged', () => {
    // On 1 November 2026 New York's clocks go back from 02:00 to 01:00, so 01:30 comes twice.
    const second = Date.UTC(2026, 10, 1, 6, 30)
    expect(new Date(second).getHours()).toBe(1)
    expect(pendingAt(pendingOf(second))).toBe(second)
    const dates = { createdAt: Date.UTC(2026, 10, 1, 6, 15), updatedAt: second }
    expect(pendingProblem('updated', pendingOf(second), dates)).toBeUndefined()
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
