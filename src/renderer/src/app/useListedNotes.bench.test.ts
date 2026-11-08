// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { BookRecord, NoteStatus, NoteSummary } from '../../../core'
import { filterNotes, noteGroups, type NoteFilter } from '../../../core/tags'
import { GROWTH_TIMEOUT } from '../../../../tests/support/growth'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { withWrites } from '../listUpdates'
import { applyOrder, type ListOrder } from '../noteSort'
import { useCountedNotes, useNoteGroups } from './useListedNotes'

afterEach(unmountAll)

const BOOK = '0192a6f0-0000-7000-8000-0000000000b1'
const books: BookRecord[] = [
  {
    id: BOOK,
    name: 'Work',
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  } as BookRecord,
]
const STATUSES: NoteStatus[] = ['none', 'active', 'completed']

const summaries = (n: number): NoteSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    // Repeated and empty titles, so ties fall to the dates.
    title: i % 7 === 0 ? '' : `Note ${i % 50}`,
    createdAt: i,
    updatedAt: (i * 7919) % n,
    bodyVersion: 0,
    bookId: i % 4 === 0 ? BOOK : null,
    status: STATUSES[i % 3]!,
    pinned: i % 11 === 0,
    tagIds: i % 3 === 0 ? ['t1'] : [],
  }))

const LOCALES = ['en']
const ORDERS: ListOrder[] = [
  { key: 'updated', direction: 'desc' },
  { key: 'updated', direction: 'asc' },
  { key: 'created', direction: 'desc' },
  { key: 'title', direction: 'asc' },
  { key: 'title', direction: 'desc' },
  'relevance',
]
const FILTERS: (NoteFilter | null)[] = [
  null,
  { kind: 'status', status: 'active' },
  { kind: 'tag', tagId: 't1' },
  { kind: 'pinned' },
]

type Props = {
  notes: NoteSummary[]
  by: NoteFilter | null
  order: ListOrder
  bookId: string | null
}

const grouped = ({ notes, by, order, bookId }: Props) =>
  useNoteGroups(notes, books, bookId, by, order, LOCALES)

const fresh = ({ notes, by, order, bookId }: Props) =>
  noteGroups(applyOrder(filterNotes(notes, books, { bookId, by }), order, LOCALES))

describe('the listed notes after a save', () => {
  it('are what listing them again gives, in every order and filter', () => {
    for (const order of ORDERS) {
      for (const by of FILTERS) {
        for (const bookId of [null, BOOK]) {
          let notes = summaries(300)
          const hook = renderHook(grouped, { props: { notes, by, order, bookId } })
          for (const ids of [[3], [0, 21, 299], [7, 14], [150]]) {
            const at = 1_000 + notes.length
            notes = withWrites(notes, new Map(ids.map((i, k) => [notes[i]!.id, at + k])))
            hook.rerender({ notes, by, order, bookId })
            expect(hook.current).toEqual(fresh({ notes, by, order, bookId }))
          }
          notes = notes.map((n, i) => (i === 5 ? { ...n, title: 'Renamed' } : n))
          hook.rerender({ notes, by, order, bookId })
          expect(hook.current).toEqual(fresh({ notes, by, order, bookId }))
          notes = notes.map((n, i) => (i === 6 ? { ...n, status: 'active', pinned: true } : n))
          hook.rerender({ notes, by, order, bookId })
          expect(hook.current).toEqual(fresh({ notes, by, order, bookId }))
          hook.unmount()
        }
      }
    }
  })

  it('stay the same lists when the note saved is not listed', () => {
    let notes = summaries(300)
    const props = { by: { kind: 'status', status: 'active' } as NoteFilter, bookId: null }
    const order: ListOrder = { key: 'title', direction: 'asc' }
    const hook = renderHook(grouped, { props: { notes, order, ...props } })
    const before = hook.current
    notes = withWrites(notes, new Map([[notes[0]!.id, 5_000]]))
    expect(notes[0]?.status).toBe('none')
    hook.rerender({ notes, order, ...props })
    expect(hook.current).toBe(before)
  })
})

describe('the notes the counts read', () => {
  it('stay the same list while saves change only dates and text', () => {
    let notes = summaries(300)
    const hook = renderHook(useCountedNotes, { props: notes })
    const counted = hook.current
    notes = withWrites(notes, new Map([[notes[1]!.id, 5_000]]))
    notes = notes.map((n, i) => (i === 2 ? { ...n, title: 'Renamed', excerpt: 'New' } : n))
    hook.rerender(notes)
    expect(hook.current).toBe(counted)
    notes = notes.map((n, i) => (i === 3 ? { ...n, tagIds: ['t2'] } : n))
    hook.rerender(notes)
    expect(hook.current).toBe(notes)
  })
})

const cpu = (work: () => void) => {
  const start = process.cpuUsage()
  work()
  const { user, system } = process.cpuUsage(start)
  return user + system
}
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] as number

it(
  'orders a large library after a save in a small share of the work of listing it again',
  () => {
    const order: ListOrder = { key: 'title', direction: 'asc' }
    const listed = summaries(50_000)
    const saves: number[] = []
    const listings: number[] = []
    for (let round = 0; round < 5; round += 1) {
      let notes = listed
      const hook = renderHook(grouped, { props: { notes, order, by: null, bookId: null } })
      notes = withWrites(notes, new Map([[notes[round * 9]!.id, 100_000 + round]]))
      const saved = notes
      saves.push(cpu(() => hook.rerender({ notes: saved, order, by: null, bookId: null })))
      const relisted = saved.map((n) => ({ ...n }))
      listings.push(cpu(() => hook.rerender({ notes: relisted, order, by: null, bookId: null })))
      hook.unmount()
    }
    const share = median(saves) / median(listings)
    expect(share).toBeLessThan(0.2)
  },
  GROWTH_TIMEOUT,
)
