import { describe, expect, it } from 'vitest'
import type { BookRecord, NoteStatus, NoteSummary, TagRecord } from '../../../core/storage'
import { libraryOf } from './library'

const book = (id: string, sortKey: string, parentId: string | null = null): BookRecord => ({
  id,
  name: id,
  nameHlc: '',
  parentId,
  parentHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  aiAccess: false,
  aiAccessHlc: '',
  sortKey,
  sortKeyHlc: '',
  icon: null,
  iconColor: null,
  iconHlc: '',
})

const tag = (id: string, name: string): TagRecord => ({
  id,
  name,
  nameHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  color: 'blue',
  colorHlc: '',
})

let next = 0
const note = (
  bookId: string | null,
  extra: { status?: NoteStatus; pinned?: boolean; tagIds?: string[] } = {},
): NoteSummary => ({
  id: `n${next++}`,
  title: '',
  createdAt: 0,
  updatedAt: 0,
  bodyVersion: 0,
  bookId,
  status: extra.status ?? 'none',
  pinned: extra.pinned ?? false,
  tagIds: extra.tagIds ?? [],
})

describe('the Library', () => {
  it('counts All Notes, Pinned, Active and Completed from the notes', () => {
    const notes = [
      note(null, { pinned: true, status: 'active' }),
      note(null, { status: 'active' }),
      note(null, { status: 'completed' }),
      note(null, { status: 'on_hold' }),
    ]
    expect(libraryOf(notes, [], [], new Set()).counts).toEqual({
      all: 4,
      pinned: 1,
      active: 2,
      completed: 1,
    })
  })

  it('orders notebooks by their sort keys and shows children only under an open parent', () => {
    const books = [book('b', 'b'), book('a', 'a'), book('child', 'a', 'a')]
    expect(libraryOf([], books, [], new Set()).books.map((r) => r.id)).toEqual(['a', 'b'])
    const open = libraryOf([], books, [], new Set(['a'])).books
    expect(open.map((r) => [r.id, r.depth, r.hasChildren, r.open])).toEqual([
      ['a', 0, true, true],
      ['child', 1, false, false],
      ['b', 0, false, false],
    ])
  })

  it('gives each level of nesting its own depth', () => {
    const books = [book('a', 'a'), book('b', 'a', 'a'), book('c', 'a', 'b')]
    const open = libraryOf([], books, [], new Set(['a', 'b'])).books
    expect(open.map((r) => [r.id, r.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
    expect(libraryOf([], books, [], new Set(['b'])).books.map((r) => r.id)).toEqual(['a'])
  })

  it('counts a notebook with its descendants, and leaves deleted notebooks out', () => {
    const gone = { ...book('gone', 'c'), deletedAt: 1 }
    const books = [book('a', 'a'), book('child', 'a', 'a'), gone]
    const notes = [note('a'), note('child'), note('child'), note('gone')]
    expect(libraryOf(notes, books, [], new Set()).books).toMatchObject([{ id: 'a', count: 3 }])
  })

  it('shows a notebook whose parent is gone at the top level', () => {
    const books = [book('orphan', 'a', 'missing')]
    expect(libraryOf([], books, [], new Set()).books).toMatchObject([{ id: 'orphan', depth: 0 }])
  })

  it('sorts tags by name and counts each note once', () => {
    const tags = [tag('t2', 'zebra'), tag('t1', 'apple')]
    const notes = [note(null, { tagIds: ['t1', 't1'] }), note(null, { tagIds: ['t1', 't2'] })]
    expect(libraryOf(notes, [], tags, new Set()).tags.map((r) => [r.name, r.count])).toEqual([
      ['apple', 2],
      ['zebra', 1],
    ])
  })
})
