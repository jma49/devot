import { describe, expect, it } from 'vitest'
import {
  backlinksOpen,
  dateInputValue,
  datesEdit,
  infoFields,
  parseDateInput,
  setBacklinksOpen,
} from './infoCard'

const info = {
  noteId: '0192a6f0-0000-7000-8000-00000000000a',
  createdAt: new Date(2026, 9, 13, 1, 43, 54).getTime(),
  updatedAt: new Date(2026, 9, 13, 1, 57, 24).getTime(),
}

describe('the note info card', () => {
  it('hides Progress for a note without tasks', () => {
    const fields = infoFields(info, { done: 0, total: 0 }, 'en')
    expect(fields.map((f) => f.key)).toEqual(['created', 'updated'])
    expect(fields.map((f) => f.value)).toEqual(['2026-10-13 01:43:54', '2026-10-13 01:57:24'])
    expect(fields.map((f) => f.label)).toEqual(['Created at', 'Updated at'])
  })

  it('shows Progress first for a note with tasks', () => {
    const [progress, ...dates] = infoFields(info, { done: 1, total: 2 }, 'en')
    expect(progress).toMatchObject({
      key: 'progress',
      label: 'Progress',
      value: '1 of 2 tasks',
      tasks: { done: 1, total: 2 },
    })
    expect(dates).toHaveLength(2)
  })
})

describe('the backlinks preference', () => {
  it('starts closed and remembers the last choice', () => {
    const kept = new Map<string, string>()
    const storage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    }
    expect(backlinksOpen(storage)).toBe(false)
    setBacklinksOpen(true, storage)
    expect(backlinksOpen(storage)).toBe(true)
    setBacklinksOpen(false, storage)
    expect(backlinksOpen(storage)).toBe(false)
  })

  it('reads as closed when storage is unavailable', () => {
    expect(backlinksOpen(undefined)).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(backlinksOpen(broken)).toBe(false)
    expect(() => setBacklinksOpen(true, broken)).not.toThrow()
  })
})

describe('editing a date on the card', () => {
  it('fills the field with the local time to the second', () => {
    expect(dateInputValue(info.createdAt)).toBe('2026-10-13T01:43:54')
  })

  it('reads the field back, with or without seconds', () => {
    expect(parseDateInput('2026-10-13T01:43:54')).toBe(info.createdAt)
    expect(parseDateInput(dateInputValue(info.updatedAt))).toBe(info.updatedAt)
    expect(parseDateInput('2020-01-02T03:04')).toBe(new Date(2020, 0, 2, 3, 4, 0).getTime())
    expect(parseDateInput(' 2020-01-02 03:04:05 ')).toBe(new Date(2020, 0, 2, 3, 4, 5).getTime())
    expect(parseDateInput('2020-01-02T03:04:05.250')).toBe(new Date(2020, 0, 2, 3, 4, 5).getTime())
  })

  it('refuses what is no date, and dates that do not exist', () => {
    for (const value of ['', 'tomorrow', '2020-01-02', '2020-02-30T10:00', '2020-13-01T10:00']) {
      expect([value, parseDateInput(value)]).toEqual([value, null])
    }
    expect(parseDateInput('2020-01-02T24:00')).toBeNull()
    expect(parseDateInput('2020-01-02T10:60')).toBeNull()
  })

  it('keeps a note created no later than it was updated', () => {
    expect(datesEdit(info, 'created', info.updatedAt)).toEqual({ createdAt: info.updatedAt })
    expect(datesEdit(info, 'created', info.updatedAt + 1)).toBeNull()
    expect(datesEdit(info, 'updated', info.createdAt)).toEqual({ updatedAt: info.createdAt })
    expect(datesEdit(info, 'updated', info.createdAt - 1)).toBeNull()
  })
})
