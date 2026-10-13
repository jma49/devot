import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../core'
import { keepRecent, staleHeadlines } from './headlines'

const note = (id: string, title: string, updatedAt = 1): NoteSummary => ({
  id,
  title,
  createdAt: 0,
  updatedAt,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
})

describe('staleHeadlines', () => {
  it('asks for untitled notes only', () => {
    const notes = [note('a', ''), note('b', 'Named'), note('c', '')]
    expect(staleHeadlines(notes, new Map()).map((n) => n.id)).toEqual(['a', 'c'])
  })

  it('does not ask again for a note that has not changed since, even when it has no text', () => {
    const cache = new Map([['a', { at: 5, text: '' }]])
    expect(staleHeadlines([note('a', '', 5)], cache)).toEqual([])
  })

  it('asks again when the note was written since', () => {
    const cache = new Map([['a', { at: 5, text: 'Old first line' }]])
    expect(staleHeadlines([note('a', '', 9)], cache).map((n) => n.id)).toEqual(['a'])
  })
})

describe('keepRecent', () => {
  it('drops the oldest entries past the limit', () => {
    const cache = new Map([1, 2, 3, 4].map((n) => [`n${n}`, { at: n, text: '' }] as const))
    keepRecent(cache, 2)
    expect([...cache.keys()]).toEqual(['n3', 'n4'])
  })
})
