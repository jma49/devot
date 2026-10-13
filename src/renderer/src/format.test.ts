import { afterEach, describe, expect, it } from 'vitest'
import { bookDeleteDetail, fileSize, noteCount, noteDate } from './format'

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
