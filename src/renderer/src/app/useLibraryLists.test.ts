// @vitest-environment happy-dom
import { act, type Dispatch, type SetStateAction } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  type NoteSummary,
  type TrashedNote,
} from '../../../core'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { tempSqliteAdapter } from '../../../../tests/support/sqlite-adapter'
import type { Core } from '../core-client'
import { NOTES_LOADED } from '../externalChanges'
import { reportingNoteWrites } from '../noteWrites'
import { fromWire, toWire } from '../storage/wire'
import type { WireRelay } from '../noteRelay'
import type { SearchResults } from '../useSearch'
import { useLibraryLists, useNoteWindowChanges, type LibraryLists } from './useLibraryLists'

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

let stored: NoteSummary[] = []
let listed = 0
const listLibrary = async () => {
  listed += 1
  return { notes: stored, templates: [] }
}

/** The core worker's lists; the notes come from the page's storage (`listLibrary`). */
function fakeCore(notes: NoteSummary[], trash: TrashedNote[] = []) {
  stored = notes
  return {
    listWithTemplates: () => {
      throw new Error('the notes were listed through the worker')
    },
    listBooks: async () => [],
    listTags: async () => [],
    listTrash: async () => trash,
    listSavedSearches: async () => [],
  } as unknown as Core
}

async function loadedDuring(run: () => Promise<unknown>) {
  const heard: unknown[] = []
  const hear = (e: Event) => heard.push((e as CustomEvent<unknown>).detail)
  window.addEventListener(NOTES_LOADED, hear)
  try {
    await act(run)
  } finally {
    window.removeEventListener(NOTES_LOADED, hear)
  }
  return heard
}

function lists() {
  const rerunSearch = vi.fn<() => void>()
  const setResults = vi.fn<Dispatch<SetStateAction<SearchResults | undefined>>>()
  return {
    hook: renderHook(useLibraryLists, { props: { rerunSearch, setResults, listLibrary } }),
    rerunSearch,
  }
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

  it("lists the notes from the page's storage once, never through the worker", async () => {
    const { hook } = lists()
    listed = 0
    const shown = await act(() => hook.current.refresh(fakeCore([note('a'), note('b')])))
    expect(listed).toBe(1)
    expect(shown.notes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(shown.trash).toEqual([])
  })

  it('dates a written note at once, or once the pending reload is done', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')])))
    act(() => hook.current.reloadStarted())
    act(() => hook.current.showWrites(new Map([['a', 5]])))
    expect(hook.current.notes[0]?.updatedAt).toBe(1)
    act(() => hook.current.reloadDone())
    expect(hook.current.notes[0]?.updatedAt).toBe(5)
    act(() => hook.current.showWrites(new Map([['a', 9]])))
    expect(hook.current.notes[0]?.updatedAt).toBe(9)
  })

  it('dates a note saved after a reload read the notes but before it installed them', async () => {
    const adapter = tempSqliteAdapter('devot-lists-')
    const rerunSearch = vi.fn<() => void>()
    const setResults = vi.fn<Dispatch<SetStateAction<SearchResults | undefined>>>()
    let notesRead = () => {}
    const hook = renderHook(useLibraryLists, {
      props: {
        rerunSearch,
        setResults,
        listLibrary: async () => {
          const notes = await adapter.listNotes()
          notesRead()
          return { notes, templates: [] }
        },
      },
    })
    let clock = 1_000
    const notes = createNoteService({
      storage: fromWire(reportingNoteWrites(toWire(adapter), (w) => hook.current.showWrites(w))),
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      now: () => clock,
      saveDelayMs: 5,
    })
    const id = await notes.create('A')
    let holdingBooks = Promise.resolve()
    const core = {
      listBooks: async () => {
        await holdingBooks
        return adapter.listBooks()
      },
      listTags: () => adapter.listTags(),
      listTrash: () => adapter.listTrash(),
      listSavedSearches: () => adapter.listSavedSearches(),
    } as unknown as Core
    await act(() => hook.current.refresh(core))
    expect(hook.current.notes.map((n) => [n.id, n.updatedAt])).toEqual([[id, 1_000]])

    const readingNotes = new Promise<void>((resolve) => (notesRead = resolve))
    let booksHeld!: () => void
    holdingBooks = new Promise<void>((resolve) => (booksHeld = resolve))
    act(() => hook.current.reloadStarted())
    let reloading!: Promise<unknown>
    act(() => void (reloading = hook.current.refresh(core)))
    await readingNotes
    clock = 2_000
    await act(async () => {
      await notes.setBody(id, 'typed')
      await notes.flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      booksHeld()
      await reloading
    })
    act(() => hook.current.reloadDone())
    expect(hook.current.notes.map((n) => [n.id, n.updatedAt])).toEqual([[id, 2_000]])
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

  it('names the notes a reload found changed, and none on the first', async () => {
    const { hook } = lists()
    expect(
      await loadedDuring(() => hook.current.refresh(fakeCore([note('a'), note('b')]))),
    ).toEqual([null])
    const next = [note('a'), { ...note('b'), bodyVersion: 2 }, note('c')]
    expect(await loadedDuring(() => hook.current.refresh(fakeCore(next)))).toEqual([['b', 'c']])
  })

  it('names no notes when a tag changed, as any chip may show it', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')])))
    const retagged = {
      ...fakeCore([note('a')]),
      listTags: async () => [{ id: 't', name: 'work', color: null, deletedAt: null }],
    } as unknown as Core
    expect(await loadedDuring(() => hook.current.refresh(retagged))).toEqual([null])
  })

  it('patches the rows of written notes without listing the library again', async () => {
    const { hook, rerunSearch } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a'), note('b')])))
    const authorship = hook.current.authorship
    const listWithTemplates = vi.fn<() => Promise<unknown>>()
    const core = {
      listWithTemplates,
      noteSummaries: async () => [{ ...note('b', 5), title: 'Renamed' }],
    } as unknown as Core
    const before = hook.current.notes
    expect(await loadedDuring(() => hook.current.patch(core, ['b']))).toEqual([['b']])
    expect(listWithTemplates).not.toHaveBeenCalled()
    expect(hook.current.notes.map((n) => [n.id, n.title])).toEqual([
      ['a', 'a'],
      ['b', 'Renamed'],
    ])
    expect(hook.current.notes[0]).toBe(before[0])
    expect(hook.current.authorship).toBe(authorship + 1)
    expect(rerunSearch).toHaveBeenCalledTimes(2)
  })

  it('patches a note moved to another notebook in place', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a'), note('b')])))
    const listWithTemplates = vi.fn<() => Promise<unknown>>()
    const core = {
      listWithTemplates,
      noteSummaries: async () => [{ ...note('b', 5), bookId: 'b2' }],
    } as unknown as Core
    expect(await loadedDuring(() => hook.current.patch(core, ['b']))).toEqual([['b']])
    expect(listWithTemplates).not.toHaveBeenCalled()
    expect(hook.current.notes.map((n) => [n.id, n.bookId])).toEqual([
      ['a', null],
      ['b', 'b2'],
    ])
  })

  it('lists the library again when a written note is not listed or no longer there', async () => {
    const { hook } = lists()
    await act(() => hook.current.refresh(fakeCore([note('a')])))
    for (const found of [[note('z')], []]) {
      const core = { ...fakeCore([note('a'), note('z')]), noteSummaries: async () => found }
      await act(() => hook.current.patch(core as unknown as Core, ['z']))
      expect(hook.current.notes.map((n) => n.id)).toEqual(['a', 'z'])
      await act(() => hook.current.refresh(fakeCore([note('a')])))
    }
  })
})

describe('useNoteWindowChanges', () => {
  it("names a note window's saved note to the mirror", async () => {
    let hear: ((message: WireRelay) => void) | undefined
    const relay = {
      link: {
        send: () => {},
        listen: (handler: (message: WireRelay) => void) => {
          hear = handler
          return Promise.resolve(() => {})
        },
      },
    }
    const mirrorTouch = vi.fn<(noteIds?: readonly string[]) => Promise<void>>(async () => {})
    const core = { relayIn: async () => {}, mirrorTouch } as unknown as Core
    const shown = {
      showWrites: () => {},
      retitleListed: () => {},
      refresh: async () => {},
      authorshipChanged: () => {},
    } as unknown as LibraryLists
    const knownNotes = { current: new Map([['a', note('a')]]) }
    renderHook(useNoteWindowChanges, { props: { core, relay, lists: shown, knownNotes } })
    act(() => hear?.({ kind: 'saved', noteId: 'a', updatedAt: 5 }))
    expect(mirrorTouch).toHaveBeenCalledExactlyOnceWith(['a'])
  })
})
