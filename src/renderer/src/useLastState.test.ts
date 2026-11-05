// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../core'
import type { Core } from './core-client'
import { lastStateStore, type LastState } from './lastState'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import { useLastState } from './useLastState'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

afterEach(unmountAll)

function memoryStore() {
  const items = new Map<string, string>()
  return lastStateStore(
    { getItem: (key) => items.get(key) ?? null, setItem: (key, text) => void items.set(key, text) },
    'main',
  )
}

const ALL = { kind: 'all' } as const
const BOOK = '01900000-0000-7000-8000-000000000001'
const NOTE = '01900000-0000-7000-8000-000000000002'
const LAYOUTS = { boards: [], galleries: [] }

type Props = Parameters<typeof useLastState>[0]

function props(overrides: Partial<Props> = {}) {
  return {
    store: memoryStore(),
    saved: undefined,
    core: undefined,
    listsLoaded: false,
    restored: true,
    setRestored: vi.fn<(done: boolean) => void>(),
    view: {
      library: ALL,
      filter: null,
      workspace: null,
      inTrash: false,
      inTemplates: false,
      bookId: undefined,
      activeFilter: null,
      mode: 'edit' as const,
      selected: undefined,
      workspaceId: undefined,
      layouts: LAYOUTS,
    },
    lists: { books: [], tags: [], notes: [], templates: [] },
    query: '',
    setLibrary: vi.fn<Props['setLibrary']>(),
    setFilter: vi.fn<Props['setFilter']>(),
    setWorkspace: vi.fn<Props['setWorkspace']>(),
    select: vi.fn<Props['select']>(async () => true),
    ...overrides,
  }
}

describe('useLastState', () => {
  it('saves the latest state through the saveNow it handed out first', () => {
    const first = props()
    const hook = renderHook(useLastState, { props: first })
    const saveNow = hook.current.saveNow
    // The notebook alone changes no save effect's dependencies: only saveNow saves it.
    hook.rerender({ ...first, view: { ...first.view, bookId: BOOK } })
    expect(hook.current.saveNow).toBe(saveNow)
    expect(first.store.load()?.view).toEqual(ALL)
    saveNow()
    expect(first.store.load()?.view).toEqual({ kind: 'book', id: BOOK })
  })

  it('saves nothing until the last state is restored', () => {
    const waiting = props({ restored: false })
    const hook = renderHook(useLastState, { props: waiting })
    hook.current.saveNow()
    window.dispatchEvent(new Event('pagehide'))
    expect(waiting.store.load()).toBeUndefined()
    hook.rerender({ ...waiting, restored: true })
    expect(waiting.store.load()?.view).toEqual(ALL)
  })

  it('stops saving on page events once unmounted', () => {
    const first = props()
    const hook = renderHook(useLastState, { props: first })
    hook.rerender({ ...first, view: { ...first.view, bookId: BOOK } })
    hook.unmount()
    window.dispatchEvent(new Event('pagehide'))
    expect(first.store.load()?.view).toEqual(ALL)
  })

  it('restores the saved view and note once the lists have loaded, and only once', async () => {
    const note = { id: NOTE } as NoteSummary
    const saved: LastState = {
      view: { kind: 'book', id: BOOK },
      filter: null,
      mode: 'edit',
      note: { id: NOTE, keyboard: false },
    }
    const loading = props({
      saved,
      restored: false,
      core: {} as Core,
      lists: {
        books: [{ id: BOOK } as never],
        tags: [],
        notes: [note],
        templates: [],
      },
    })
    const hook = renderHook(useLastState, { props: loading })
    expect(loading.select).not.toHaveBeenCalled()
    hook.rerender({ ...loading, listsLoaded: true })
    await settle()
    hook.rerender({ ...loading, listsLoaded: true })
    await settle()
    expect(loading.setLibrary).toHaveBeenCalledExactlyOnceWith({ kind: 'book', id: BOOK })
    expect(loading.select).toHaveBeenCalledExactlyOnceWith(NOTE, { keyboard: false })
    expect(loading.setRestored).toHaveBeenCalledExactlyOnceWith(true)
  })
})
