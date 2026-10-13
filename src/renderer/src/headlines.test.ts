import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../core'
import {
  displayTitle,
  displayTitles,
  keepRecent,
  mergeHeadlines,
  newestUntitled,
  staleHeadlines,
} from './headlines'

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

describe('mergeHeadlines', () => {
  it('keeps the old headline until the answer for the new write arrives', () => {
    const cache = new Map([['a', { at: 5, text: 'Old' }]])
    // The note was written (updatedAt 9): the row still has the cached text,
    // and asks for the new one.
    expect(staleHeadlines([note('a', '', 9)], cache)).toHaveLength(1)
    expect(cache.get('a')?.text).toBe('Old')
    const next = mergeHeadlines(cache, { a: 'New' }, new Map([['a', 9]]))
    expect(next.get('a')).toEqual({ at: 9, text: 'New' })
  })

  it('never lets an answer for an older write hide a newer one', () => {
    const cache = new Map([['a', { at: 9, text: 'New' }]])
    const next = mergeHeadlines(cache, { a: 'Old' }, new Map([['a', 5]]))
    expect(next.get('a')).toEqual({ at: 9, text: 'New' })
  })
})

describe('displayTitle', () => {
  it('is the title, else the headline, else Untitled', () => {
    expect(displayTitle('Plan', 'First line')).toBe('Plan')
    expect(displayTitle('', 'First line')).toBe('First line')
    expect(displayTitle('', '')).toBe('Untitled')
    expect(displayTitle('', undefined)).toBe('Untitled')
  })
})

describe('newestUntitled', () => {
  it('keeps the most recently written untitled notes, newest first', () => {
    const notes = [note('a', '', 1), note('b', 'Named', 9), note('c', '', 3), note('d', '', 2)]
    expect(newestUntitled(notes, 2).map((n) => n.id)).toEqual(['c', 'd'])
    expect(notes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('displayTitles', () => {
  it('looks up untitled notes only and names each as the list does', async () => {
    const asked: string[][] = []
    const load = (ids: string[]) => {
      asked.push(ids)
      return Promise.resolve({ b: 'Second', c: '' })
    }
    const named = await displayTitles(load, [
      { id: 'a', title: 'Named' },
      { id: 'b', title: '' },
      { id: 'c', title: '' },
      { id: 'd', title: '' },
    ])
    expect(asked).toEqual([['b', 'c', 'd']])
    expect([...named]).toEqual([
      ['a', 'Named'],
      ['b', 'Second'],
      ['c', 'Untitled'],
      ['d', 'Untitled'],
    ])
  })

  it('asks for nothing when every note has a title, and survives a failed lookup', async () => {
    let calls = 0
    const load = () => {
      calls += 1
      return Promise.reject(new Error('E_X'))
    }
    expect([...(await displayTitles(load, [{ id: 'a', title: 'A' }]))]).toEqual([['a', 'A']])
    expect(calls).toBe(0)
    expect([...(await displayTitles(load, [{ id: 'b', title: '' }]))]).toEqual([['b', 'Untitled']])
    expect(await displayTitles(undefined, [{ id: 'b', title: '' }])).toEqual(
      new Map([['b', 'Untitled']]),
    )
  })
})
