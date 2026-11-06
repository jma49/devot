// @vitest-environment happy-dom
import { act, type Dispatch, type SetStateAction } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary, TrashedNote } from '../../../core'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import type { Core } from '../core-client'
import type { SearchResults } from '../useSearch'
import { useLibraryLists } from './useLibraryLists'

afterEach(unmountAll)

const note = (id: string, updatedAt = 1): NoteSummary => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt,
  bodyVersion: 0,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
})

const trashed = (id: string): TrashedNote =>
  ({ id, title: id, deletedAt: 7, bookId: 'b1' }) as TrashedNote

function fakeCore(notes: NoteSummary[], trash: TrashedNote[] = []) {
  return {
    listWithTemplates: async () => ({ notes, templates: [] }),
    listBooks: async () => [],
    listTags: async () => [],
    listTrash: async () => trash,
    listSavedSearches: async () => [],
  } as unknown as Core
}

function lists() {
  const rerunSearch = vi.fn<() => void>()
  const setResults = vi.fn<Dispatch<SetStateAction<SearchResults | undefined>>>()
  return { hook: renderHook(useLibraryLists, { props: { rerunSearch, setResults } }), rerunSearch }
}

describe('useLibraryLists', () => {
  it('lists what the core lists, the Trash as rows dated when trashed', async () => {
    const { hook, rerunSearch } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')], [trashed('t')])))
    expect(hook.current.notes.map((n) => n.id)).toEqual(['a'])
    expect(hook.current.trashRows).toEqual([
      expect.objectContaining({ id: 't', createdAt: 7, updatedAt: 7, bookId: 'b1', pinned: false }),
    ])
    expect(rerunSearch).toHaveBeenCalledOnce()
  })

  it('dates a written note at once, but not while a reload is pending', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')])))
    act(() => hook.current.reloadStarted())
    act(() => hook.current.showWrites(new Map([['a', 5]])))
    expect(hook.current.notes[0]?.updatedAt).toBe(1)
    act(() => hook.current.reloadDone())
    act(() => hook.current.showWrites(new Map([['a', 9]])))
    expect(hook.current.notes[0]?.updatedAt).toBe(9)
  })

  it('keeps a reload pending until every change that started one is done', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')])))
    act(() => {
      hook.current.reloadStarted()
      hook.current.reloadStarted()
      hook.current.reloadDone()
    })
    act(() => hook.current.showWrites(new Map([['a', 5]])))
    expect(hook.current.notes[0]?.updatedAt).toBe(1)
  })

  it('shows a title in the lists without a reload', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')])))
    act(() => hook.current.retitleListed('a', 'Renamed'))
    expect(hook.current.notes[0]?.title).toBe('Renamed')
  })
})
