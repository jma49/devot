import { describe, expect, it } from 'vitest'
import { backlinksOpen, infoFields, setBacklinksOpen } from './infoCard'

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
