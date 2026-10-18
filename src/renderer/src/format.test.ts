import { afterEach, describe, expect, it } from 'vitest'
import {
  bookDeleteDetail,
  fileSize,
  listCaption,
  noteCount,
  noteDate,
  relativeTime,
  rowDate,
  stampDate,
  taskCount,
} from './format'

/** Counts `new Intl.DateTimeFormat(...)` until the test ends. */
function countDateFormats(): { count: number } {
  const seen = { count: 0 }
  const original = Intl.DateTimeFormat
  Intl.DateTimeFormat = new Proxy(original, {
    construct(target, args: unknown[]) {
      seen.count += 1
      return Reflect.construct(target, args) as object
    },
    apply(target, self, args: unknown[]) {
      seen.count += 1
      return Reflect.apply(target, self, args) as unknown
    },
  })
  restore.push(() => (Intl.DateTimeFormat = original))
  return seen
}
const restore: (() => void)[] = []
afterEach(() => restore.splice(0).forEach((undo) => undo()))

describe('relativeTime', () => {
  const now = new Date(2026, 9, 10, 15, 30).getTime()

  it('says how long since a note changed', () => {
    expect(relativeTime(now - 5_000, now, 'en')).toBe('a few seconds')
    expect(relativeTime(now - 60_000, now, 'en')).toBe('1 minute')
    expect(relativeTime(now - 7 * 60_000, now, 'en')).toBe('7 minutes')
    expect(relativeTime(now - 3 * 3_600_000, now, 'en')).toBe('3 hours')
    expect(relativeTime(now - 3 * 86_400_000, now, 'en')).toBe('3 days')
  })

  it('falls back to the date after a month', () => {
    expect(relativeTime(new Date(2026, 7, 1).getTime(), now, 'en')).toBe('Aug 1, 2026')
  })
})

describe('noteDate', () => {
  const now = new Date(2026, 9, 10, 15, 30).getTime()

  it('shows the time for notes updated today', () => {
    // Intl separates the day period with a narrow no-break space.
    expect(noteDate(new Date(2026, 9, 10, 9, 5).getTime(), now, 'en')).toMatch(/^9:05\sAM$/)
  })

  it('shows the date for older notes', () => {
    expect(noteDate(new Date(2026, 9, 9, 23, 59).getTime(), now, 'en')).toBe('Oct 9, 2026')
  })

  it('builds a formatter once per locale and style, not once per row', () => {
    const made = countDateFormats()
    for (let i = 0; i < 500; i += 1) {
      noteDate(now - i * 60_000, now, 'en-GB')
      noteDate(now - i * 86_400_000, now, 'en-GB')
    }
    expect(made.count).toBeLessThanOrEqual(2)
    // Another locale gets its own.
    expect(noteDate(new Date(2026, 9, 9).getTime(), now, 'de')).toBe('09.10.2026')
  })
})

describe('rowDate', () => {
  const now = new Date(2026, 9, 10, 15, 30).getTime()
  const recent = now - 3 * 3_600_000

  it('shows how long ago in relative style', () => {
    expect(rowDate(recent, now, 'en', 'relative')).toBe('3 hours')
    expect(rowDate(now - 3 * 86_400_000, now, 'en', 'relative')).toBe('3 days')
  })

  it('shows the time for today and the medium date otherwise in absolute style', () => {
    expect(rowDate(new Date(2026, 9, 10, 9, 5).getTime(), now, 'en', 'absolute')).toMatch(
      /^9:05\sAM$/,
    )
    expect(rowDate(now - 3 * 86_400_000, now, 'en', 'absolute')).toBe('Oct 7, 2026')
    expect(rowDate(new Date(2026, 7, 1).getTime(), now, 'en', 'absolute')).toBe('Aug 1, 2026')
  })

  it('keeps the relative style beyond a month as the date', () => {
    const old = new Date(2026, 7, 1).getTime()
    expect(rowDate(old, now, 'en', 'relative')).toBe(rowDate(old, now, 'en', 'absolute'))
  })
})

describe('noteCount', () => {
  it('uses the plural rules of the locale', () => {
    expect(noteCount(0, 'en')).toBe('0 notes')
    expect(noteCount(1, 'en')).toBe('1 note')
    expect(noteCount(1234, 'en')).toBe('1,234 notes')
  })
})

describe('fileSize', () => {
  it('uses kilobytes below a megabyte and megabytes above', () => {
    expect(fileSize(900, 'en')).toBe('1 kB')
    expect(fileSize(250_000, 'en')).toBe('250 kB')
    expect(fileSize(12_345_678, 'en')).toBe('12.3 MB')
  })

  it('uses gigabytes from a gigabyte on, and shows nothing as 0 kB', () => {
    expect(fileSize(2_345_678_901, 'en')).toBe('2.3 GB')
    expect(fileSize(0, 'en')).toBe('0 kB')
  })
})

describe('bookDeleteDetail', () => {
  it('says what goes and what stays, with the right plurals', () => {
    expect(bookDeleteDetail(0, 0)).toBe('It is empty. You can\u2019t undo this.')
    expect(bookDeleteDetail(0, 1)).toBe(
      'It holds 1 note, which will stay without a notebook. You can\u2019t undo this.',
    )
    expect(bookDeleteDetail(1, 0)).toBe(
      'Its 1 sub-notebook will be deleted too. You can\u2019t undo this.',
    )
    expect(bookDeleteDetail(3, 12)).toBe(
      'Its 3 sub-notebooks will be deleted too. Together they hold 12 notes, which will stay without a notebook. You can\u2019t undo this.',
    )
  })
})

describe('stampDate', () => {
  it('writes the local date and time as YYYY-MM-DD HH:mm:ss, zero-padded', () => {
    expect(stampDate(new Date(2026, 0, 5, 7, 8, 9).getTime())).toBe('2026-01-05 07:08:09')
    expect(stampDate(new Date(2026, 9, 13, 23, 59, 30).getTime())).toBe('2026-10-13 23:59:30')
  })
})

describe('taskCount', () => {
  it('says how many tasks are done of how many, with the plural of the total', () => {
    expect(taskCount(1, 2, 'en')).toBe('1 of 2 tasks')
    expect(taskCount(0, 1, 'en')).toBe('0 of 1 task')
  })
})

describe('listCaption', () => {
  it('counts the notes, naming the scope of a scoped view', () => {
    expect(listCaption(3, undefined, 'en')).toBe('3 notes')
    expect(listCaption(1, 'In Work', 'en')).toBe('In Work \u00b7 1 note')
  })
})
