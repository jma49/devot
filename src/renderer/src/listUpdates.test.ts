import { describe, expect, it } from 'vitest'
import type { BookRecord, NoteSummary } from '../../core'
import { TEMPLATES_BOOK_ID } from '../../core/books'
import { homeOf, keepUnchanged, retitled, sameCounts, viewLists, withWrites } from './listUpdates'

const note = (id: string, extra: Partial<NoteSummary> = {}): NoteSummary => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 10,
  bodyVersion: 1,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
  ...extra,
})

const book = (id: string, parentId: string | null = null): BookRecord =>
  ({ id, name: id, parentId }) as unknown as BookRecord

describe('withWrites', () => {
  it('dates the notes written since with their new time', () => {
    const list = [note('a'), note('b'), note('c')]
    const next = withWrites(list, new Map([['b', 20]]))
    expect(next.map((n) => n.updatedAt)).toEqual([10, 20, 10])
    // The rest keep their objects, so their rows do not render again.
    expect(next[0]).toBe(list[0])
    expect(next[2]).toBe(list[2])
  })

  it('returns the same list when no write concerns it', () => {
    const list = [note('a'), note('b')]
    expect(withWrites(list, new Map([['z', 20]]))).toBe(list)
    // A write that is not newer (an older save landing late) changes nothing.
    expect(withWrites(list, new Map([['a', 5]]))).toBe(list)
  })
})

describe('keepUnchanged', () => {
  it('keeps the earlier object of every note that did not change', () => {
    const prev = [note('a', { tagIds: ['t'] }), note('b')]
    const next = [note('a', { tagIds: ['t'] }), note('b', { title: 'B' })]
    const kept = keepUnchanged(prev, next)
    expect(kept[0]).toBe(prev[0])
    expect(kept[1]).toBe(next[1])
  })

  it('returns the earlier list when nothing changed, and the new one when the order did', () => {
    const prev = [note('a'), note('b', { excerpt: 'x' })]
    expect(keepUnchanged(prev, [note('a'), note('b', { excerpt: 'x' })])).toBe(prev)
    const swapped = keepUnchanged(prev, [note('b', { excerpt: 'x' }), note('a')])
    expect(swapped).not.toBe(prev)
    expect(swapped[0]).toBe(prev[1])
    expect(swapped[1]).toBe(prev[0])
  })

  it('treats any field as a change', () => {
    const prev = [note('a')]
    for (const change of [
      { title: 'x' },
      { updatedAt: 11 },
      { createdAt: 2 },
      { bookId: 'b' },
      { status: 'active' as const },
      { pinned: true },
      { tagIds: ['t'] },
      { excerpt: 'e' },
    ]) {
      expect(keepUnchanged(prev, [note('a', change)])[0]).not.toBe(prev[0])
    }
  })
})

describe('retitled', () => {
  it('renames the note listed and keeps the rest', () => {
    const list = [note('a'), note('b')]
    const next = retitled(list, 'b', 'New')
    expect(next.map((n) => n.title)).toEqual(['a', 'New'])
    expect(next[0]).toBe(list[0])
  })

  it('returns the same list when the note is not listed or already has the title', () => {
    const list = [note('a')]
    expect(retitled(list, 'z', 'New')).toBe(list)
    expect(retitled(list, 'a', 'a')).toBe(list)
  })
})

describe('viewLists', () => {
  const books = [book('work'), book('sub', 'work'), book('home')]

  it('lists a note in the library by its notebook and the filter', () => {
    const plain = note('a', { bookId: 'sub' })
    const all = { kind: 'library', bookId: null, filter: null } as const
    expect(viewLists(all, plain, books)).toBe(true)
    expect(viewLists({ ...all, bookId: 'work' }, plain, books)).toBe(true)
    expect(viewLists({ ...all, bookId: 'home' }, plain, books)).toBe(false)
    expect(viewLists({ ...all, filter: { kind: 'pinned' } }, plain, books)).toBe(false)
    expect(
      viewLists({ ...all, filter: { kind: 'pinned' } }, { ...plain, pinned: true }, books),
    ).toBe(true)
    expect(viewLists({ ...all, filter: { kind: 'status', status: 'active' } }, plain, books)).toBe(
      false,
    )
    expect(viewLists({ ...all, filter: { kind: 'tag', tagId: 't' } }, plain, books)).toBe(false)
    expect(
      viewLists(
        { ...all, filter: { kind: 'tag', tagId: 't' } },
        { ...plain, tagIds: ['t'] },
        books,
      ),
    ).toBe(true)
  })

  it('lists templates only in Templates, and nothing in the Trash', () => {
    const template = note('t', { bookId: TEMPLATES_BOOK_ID })
    const all = { kind: 'library', bookId: null, filter: null } as const
    expect(viewLists({ kind: 'templates' }, template, books)).toBe(true)
    expect(viewLists({ kind: 'templates' }, note('a'), books)).toBe(false)
    expect(viewLists(all, template, books)).toBe(false)
    expect(viewLists({ kind: 'trash' }, note('a'), books)).toBe(false)
  })
})

describe('homeOf', () => {
  it("is the note's notebook, All Notes without one, and Templates for a template", () => {
    expect(homeOf(note('a', { bookId: 'work' }))).toEqual({ kind: 'book', id: 'work' })
    expect(homeOf(note('a'))).toEqual({ kind: 'all' })
    expect(homeOf(note('t', { bookId: TEMPLATES_BOOK_ID }))).toEqual({ kind: 'templates' })
  })
})

describe('sameCounts', () => {
  it('compares counts by content', () => {
    expect(sameCounts(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(true)
    expect(sameCounts(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false)
    expect(sameCounts(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(false)
    expect(
      sameCounts(
        new Map([['a', 1]]),
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
      ),
    ).toBe(false)
  })
})
