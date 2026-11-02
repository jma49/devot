import { describe, expect, it } from 'vitest'
import type { BookRecord, NoteStatus, NoteSummary } from '../../../core/storage'
import {
  filterCounts,
  inView,
  noteSections,
  orderNotes,
  sectionCollapsed,
  withStatus,
} from './noteList'

let next = 0
const note = (
  extra: Partial<Pick<NoteSummary, 'bookId' | 'pinned' | 'updatedAt' | 'tagIds'>> & {
    status?: NoteStatus
  } = {},
): NoteSummary => ({
  id: `n${next++}`,
  title: '',
  createdAt: 0,
  updatedAt: extra.updatedAt ?? 0,
  bodyVersion: 0,
  bookId: extra.bookId ?? null,
  status: extra.status ?? 'none',
  pinned: extra.pinned ?? false,
  tagIds: extra.tagIds ?? [],
})

const book = (id: string, parentId: string | null = null): BookRecord => ({
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
  sortKey: 'a',
  sortKeyHlc: '',
  icon: null,
  iconColor: null,
  iconHlc: '',
})

describe('the note list order', () => {
  it('puts pinned notes first, each group newest first', () => {
    const old = note({ updatedAt: 1 })
    const fresh = note({ updatedAt: 9 })
    const pinnedOld = note({ updatedAt: 2, pinned: true })
    const pinnedNew = note({ updatedAt: 5, pinned: true })
    expect(orderNotes([old, pinnedOld, fresh, pinnedNew]).map((n) => n.id)).toEqual([
      pinnedNew.id,
      pinnedOld.id,
      fresh.id,
      old.id,
    ])
  })

  it('puts a new note at the top of the unpinned notes, below the pinned ones', () => {
    const pinned = note({ updatedAt: 1, pinned: true })
    const created = note({ updatedAt: 100 })
    expect(orderNotes([pinned, note({ updatedAt: 50 }), created])[1]?.id).toBe(created.id)
  })
})

describe('the note list sections', () => {
  const titled = (updatedAt: number, extra: Parameters<typeof note>[0] = {}) =>
    note({ ...extra, updatedAt })
  const keys = (notes: NoteSummary[]) => noteSections(notes).map((section) => section.key)

  it('puts each note in one section, a pinned completed note in Pinned', () => {
    const pinned = titled(1, { pinned: true })
    const pinnedDone = titled(2, { pinned: true, status: 'completed' })
    const active = titled(3, { status: 'active' })
    const dropped = titled(4, { status: 'dropped' })
    const plain = titled(5)
    const done = titled(6, { status: 'completed' })
    const [first, second, third] = noteSections([pinned, pinnedDone, active, dropped, plain, done])
    expect(first!.key).toBe('pinned')
    expect(first!.notes).toEqual([pinnedDone, pinned])
    expect(second!.key).toBe('recent')
    expect(second!.notes).toEqual([plain, dropped, active])
    expect(third!.key).toBe('completed')
    expect(third!.notes).toEqual([done])
  })

  it('orders newest first, then by id so the order is stable', () => {
    const a = { ...titled(5), id: 'a' }
    const b = { ...titled(5), id: 'b' }
    const newer = titled(6)
    expect(noteSections([b, a, newer])[0]!.notes).toEqual([newer, a, b])
  })

  it('leaves out empty sections', () => {
    expect(keys([])).toEqual([])
    expect(keys([titled(1)])).toEqual(['recent'])
    expect(keys([titled(1, { status: 'completed' })])).toEqual(['completed'])
  })

  it('collapses only Completed by default, unless filtering for it', () => {
    expect(sectionCollapsed('completed', {}, 'all')).toBe(true)
    expect(sectionCollapsed('recent', {}, 'all')).toBe(false)
    expect(sectionCollapsed('pinned', {}, 'all')).toBe(false)
    expect(sectionCollapsed('completed', {}, 'completed')).toBe(false)
  })

  it('keeps what was chosen', () => {
    expect(sectionCollapsed('completed', { completed: false }, 'all')).toBe(false)
    expect(sectionCollapsed('recent', { recent: true }, 'all')).toBe(true)
    expect(sectionCollapsed('completed', { completed: true }, 'completed')).toBe(true)
  })
})

describe('what a view shows', () => {
  const books = [book('parent'), book('child', 'parent'), book('other')]

  it('shows a notebook with its descendants', () => {
    const notes = [note({ bookId: 'parent' }), note({ bookId: 'child' }), note({ bookId: 'other' })]
    expect(inView(notes, { kind: 'book', id: 'parent' }, books)).toHaveLength(2)
  })

  it('shows the pinned notes, and a tag', () => {
    const notes = [note({ pinned: true }), note({ tagIds: ['t'] }), note()]
    expect(inView(notes, { kind: 'pinned' }, books)).toHaveLength(1)
    expect(inView(notes, { kind: 'tag', id: 't' }, books)).toHaveLength(1)
    expect(inView(notes, { kind: 'all' }, books)).toHaveLength(3)
  })
})

describe('the status filter', () => {
  const notes = [
    note({ status: 'active' }),
    note({ status: 'active' }),
    note({ status: 'on_hold' }),
    note({ status: 'completed' }),
    note({ status: 'dropped' }),
  ]

  it('counts each status live', () => {
    expect(filterCounts(notes)).toEqual({
      all: 5,
      active: 2,
      on_hold: 1,
      completed: 1,
    })
  })

  it('keeps only the chosen status, or everything', () => {
    expect(withStatus(notes, 'active')).toHaveLength(2)
    expect(withStatus(notes, 'all')).toHaveLength(5)
  })
})
