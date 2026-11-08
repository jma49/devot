// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../../core'
import { useNoteGroups } from './useListedNotes'
import { retitled, withSummaries, withWrites } from '../listUpdates'
import type { ListOrder } from '../noteSort'
import { collected } from '../../../../tests/support/collected'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'

afterEach(unmountAll)

const summaries = (n: number): NoteSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    title: `Note ${i}`,
    createdAt: i,
    updatedAt: i,
    bodyVersion: 0,
    bookId: null,
    status: 'none',
    pinned: i % 11 === 0,
    tagIds: [],
  }))

const ORDER: ListOrder = { key: 'updated', direction: 'desc' }
const grouped = (notes: NoteSummary[]) => useNoteGroups(notes, [], null, null, ORDER, ['en'])

describe('the note lists of earlier saves', () => {
  it('are let go once the window lists newer ones', async () => {
    let notes = summaries(500)
    const hook = renderHook(grouped, { props: notes })
    const earlier: WeakRef<object>[] = []
    const id = notes[3]!.id
    for (let save = 1; save <= 30; save += 1) {
      notes = withWrites(notes, new Map([[id, 1_000 + save]]))
      notes = withSummaries(notes, [{ ...notes.find((n) => n.id === id)!, bodyVersion: save }])
      notes = retitled(notes, id, `Saved ${save}`)
      hook.rerender(notes)
      // React keeps the render before the last as well.
      if (save < 29) earlier.push(new WeakRef(notes), new WeakRef(hook.current))
    }
    expect(hook.current.others[0]?.title).toBe('Saved 30')
    expect(await collected(earlier)).toBe(true)
  })
})
