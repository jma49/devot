// @vitest-environment happy-dom
import {
  act,
  createElement,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../../core'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import type { ListSelection } from '../listSelection'
import { settle } from '../../../../tests/support/render-hook'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'
import { useMode } from './useMode'
import { useNoteOpening } from './useNoteOpening'
import { useOpenNote } from './useOpenNote'
import type { useViewChanges } from './useViewChanges'

const note = (id: string, bookId: string | null = null): NoteSummary => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  bodyVersion: 0,
  bookId,
  status: 'none',
  pinned: false,
  tagIds: [],
})

/** A core whose notes open at once, unless a title is held back with `holdTitle`. */
function fakeCore(known: readonly string[]) {
  const calls: string[] = []
  const held = new Map<string, () => void>()
  const core = {
    flush: async () => void calls.push('flush'),
    hold: async (id: string) => void calls.push(`hold ${id}`),
    unhold: async (id: string) => void calls.push(`unhold ${id}`),
    open: async (id: string) => {
      calls.push(`open ${id}`)
      return { state: new Uint8Array([id.length]) }
    },
    title: async (id: string) => {
      calls.push(`title ${id}`)
      const wait = held.get(id)
      if (wait) await new Promise<void>((resolve) => held.set(id, resolve))
      if (!known.includes(id)) throw new Error('E_NOTE_NOT_FOUND')
      return `Title ${id}`
    },
  }
  return {
    core: core as unknown as Core,
    calls,
    holdTitle: (id: string) => held.set(id, () => {}),
    releaseTitle: (id: string) => held.get(id)?.(),
  }
}

interface Props {
  core: Core
  notes: NoteSummary[]
  listedIds?: string[]
  inTrash?: boolean
  workspaceIds?: ReadonlySet<string>
  /** Stands in for the editor: it takes the body opened ahead for the note it shows. */
  editorTakes?: boolean
}

interface Navigation {
  selected: string | undefined
  multi: ListSelection | undefined
  workspace: string | null
  open: ReturnType<typeof useOpenNote>
  opening: ReturnType<typeof useNoteOpening>
  showLibrary: ReturnType<typeof vi.fn<(next: { kind: string }) => void>>
}

const taken: (Uint8Array | undefined)[] = []

function Editor({
  core,
  noteId,
  take,
}: {
  core: Core
  noteId: string
  take: (core: Core, noteId: string) => Uint8Array | undefined
}) {
  useLayoutEffect(() => {
    taken.push(take(core, noteId))
  }, [core, noteId, take])
  return null
}

function render(initial: Props) {
  const result: { current: Navigation | undefined } = { current: undefined }
  const showLibrary = vi.fn<(next: { kind: string }) => void>()
  const report = (nav: Navigation) => {
    result.current = nav
  }
  function Window(props: Props) {
    const [selected, setSelected] = useState<string>()
    const [, setBuiltIn] = useState<string>()
    const [multi, setMulti] = useState<ListSelection>()
    const [workspace, setWorkspace] = useState<string | null>(props.workspaceIds ? 'space' : null)
    const editorRef = useRef<EditorHandle | null>(null)
    const panesRef = useRef<HTMLDivElement | null>(null)
    const paletteFromEditor = useRef(false)
    const firstNoteWanted = useRef(false)
    const opening = useNoteOpening({ selected, editorRef, panesRef })
    const modes = useMode(undefined)
    const view = {
      setMulti,
      workspace,
      workspaceIds: workspace === null ? undefined : props.workspaceIds,
      setWorkspace,
      libraryBook: undefined,
      groups: { pinned: [], others: [] },
      listedIds: props.listedIds ?? props.notes.map((n) => n.id),
      inTrash: props.inTrash ?? false,
    } as unknown as ViewState
    const lists = { notes: props.notes, templates: [] } as unknown as LibraryLists
    const viewChanges = {
      firstNoteWanted,
      firstNoteDone: () => {},
      showLibrary,
    } as unknown as ReturnType<typeof useViewChanges>
    const open = useOpenNote({
      core: props.core,
      selected,
      setSelected,
      setBuiltIn,
      setChangeNotice: (() => {}) as Dispatch<SetStateAction<string | undefined>>,
      opening,
      lists,
      view,
      viewChanges,
      modes,
      editorRef,
      paletteFromEditor,
      requestFocus: () => {},
    })
    useLayoutEffect(() => {
      report({ selected, multi, workspace, open, opening, showLibrary })
    })
    return props.editorTakes && selected !== undefined
      ? createElement(Editor, { core: props.core, noteId: selected, take: opening.takePreopened })
      : null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Window, initial)))
  unmounts.push(() => act(() => root.unmount()))
  return {
    get current() {
      return result.current!
    },
    rerender: (next: Props) => act(() => root.render(createElement(Window, next))),
  }
}

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  taken.length = 0
  vi.restoreAllMocks()
})

const select = async (nav: { current: Navigation }, id: string) => {
  let opened: boolean | undefined
  await act(async () => {
    opened = await nav.current.open.select(id)
  })
  return opened
}

const step = async (nav: { current: Navigation }, by: -1 | 1) => {
  await act(async () => {
    await nav.current.open.step(by)
  })
}

describe('useOpenNote: select', () => {
  it('saves first, then opens the note and shows its title', async () => {
    const { core, calls } = fakeCore(['a'])
    const nav = render({ core, notes: [note('a')] })
    expect(await select(nav, 'a')).toBe(true)
    expect(calls.slice(0, 4)).toEqual(['flush', 'hold a', 'open a', 'title a'])
    expect(nav.current.selected).toBe('a')
    expect(nav.current.opening.title).toBe('Title a')
  })

  it('leaves the selection alone for a note that is gone, logging its id and code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { core, calls } = fakeCore(['a'])
    const nav = render({ core, notes: [note('a')] })
    await select(nav, 'a')
    expect(await select(nav, 'gone')).toBe(false)
    expect(nav.current.selected).toBe('a')
    expect(nav.current.opening.openingId).toBeUndefined()
    expect(calls).toContain('unhold gone')
    expect(warn).toHaveBeenCalledWith('W_NOTE_OPEN_FAILED', 'gone', 'E_NOTE_NOT_FOUND')
  })

  it('leaves the selection to a later open that overtakes it', async () => {
    const { core, calls, holdTitle, releaseTitle } = fakeCore(['a', 'b'])
    const nav = render({ core, notes: [note('a'), note('b')] })
    holdTitle('a')
    let first: Promise<boolean> | undefined
    act(() => {
      first = nav.current.open.select('a')
    })
    await settle()
    expect(nav.current.opening.openingId).toBe('a')
    await select(nav, 'b')
    releaseTitle('a')
    let opened: boolean | undefined
    await act(async () => {
      opened = await first
    })
    expect(opened).toBe(false)
    expect(nav.current.selected).toBe('b')
    expect(calls).toContain('unhold a')
  })

  it('clears a multiple selection, unless the selection itself moved the open note', async () => {
    const { core } = fakeCore(['a', 'b', 'c'])
    const nav = render({ core, notes: [note('a'), note('b'), note('c')] })
    await select(nav, 'a')
    act(() => nav.current.open.changeSelection({ ids: ['a', 'b'], anchor: 'a', lead: 'b' }))
    await settle()
    expect(nav.current.multi?.ids).toEqual(['a', 'b'])
    await select(nav, 'c')
    expect(nav.current.multi).toBeUndefined()
  })

  it('leaves the workspace for a note opened outside it', async () => {
    const { core } = fakeCore(['in', 'out'])
    const nav = render({
      core,
      notes: [note('in', 'book'), note('out', 'elsewhere')],
      workspaceIds: new Set(['book']),
    })
    await select(nav, 'in')
    expect(nav.current.workspace).toBe('space')
    await select(nav, 'out')
    expect(nav.current.workspace).toBeNull()
  })
})

describe('useOpenNote: Back and Forward', () => {
  it('steps back and forward along the notes opened', async () => {
    const { core } = fakeCore(['a', 'b', 'c'])
    const nav = render({ core, notes: [note('a'), note('b'), note('c')] })
    expect(nav.current.open.backAt).toBeUndefined()
    for (const id of ['a', 'b', 'c']) await select(nav, id)
    expect(nav.current.open.backAt).toBe(1)
    expect(nav.current.open.forwardAt).toBeUndefined()
    await step(nav, -1)
    expect(nav.current.selected).toBe('b')
    await step(nav, -1)
    expect(nav.current.selected).toBe('a')
    expect(nav.current.open.backAt).toBeUndefined()
    expect(nav.current.open.forwardAt).toBe(1)
    await step(nav, 1)
    expect(nav.current.selected).toBe('b')
    expect(nav.current.opening.trail.ids).toEqual(['a', 'b', 'c'])
  })

  it('drops the entries ahead when a note opens after going back', async () => {
    const { core } = fakeCore(['a', 'b', 'c', 'd'])
    const nav = render({ core, notes: ['a', 'b', 'c', 'd'].map((id) => note(id)) })
    for (const id of ['a', 'b', 'c']) await select(nav, id)
    await step(nav, -1)
    await select(nav, 'd')
    expect(nav.current.opening.trail).toEqual({ ids: ['a', 'b', 'd'], at: 2 })
    expect(nav.current.open.forwardAt).toBeUndefined()
  })

  it('skips notes deleted since they were opened', async () => {
    const { core } = fakeCore(['a', 'b', 'c'])
    const props = { core, notes: [note('a'), note('b'), note('c')] }
    const nav = render(props)
    for (const id of ['a', 'b', 'c']) await select(nav, id)
    nav.rerender({ ...props, notes: [note('a'), note('c')] })
    expect(nav.current.open.backAt).toBe(0)
    await step(nav, -1)
    expect(nav.current.selected).toBe('a')
  })

  it('goes back to the library from the Trash, to the current entry itself', async () => {
    const { core } = fakeCore(['a', 'b'])
    const props = { core, notes: [note('a'), note('b')] }
    const nav = render(props)
    await select(nav, 'a')
    await select(nav, 'b')
    nav.rerender({ ...props, inTrash: true })
    expect(nav.current.open.backAt).toBe(1)
    await step(nav, -1)
    expect(nav.current.showLibrary).toHaveBeenCalledWith({ kind: 'all' })
    expect(nav.current.selected).toBe('b')
  })

  it('steps on from a note still opening when pressed quickly', async () => {
    const { core, holdTitle, releaseTitle } = fakeCore(['a', 'b', 'c'])
    const nav = render({ core, notes: [note('a'), note('b'), note('c')] })
    for (const id of ['a', 'b', 'c']) await select(nav, id)
    holdTitle('b')
    act(() => void nav.current.open.step(-1))
    await settle()
    await step(nav, -1)
    releaseTitle('b')
    await settle()
    expect(nav.current.selected).toBe('a')
    expect(nav.current.opening.trail.at).toBe(0)
  })

  it('opens the next and previous listed notes', async () => {
    const { core } = fakeCore(['a', 'b', 'c'])
    const nav = render({ core, notes: [note('a'), note('b'), note('c')] })
    await select(nav, 'b')
    expect([nav.current.open.previousId, nav.current.open.nextId]).toEqual(['a', 'c'])
    await act(async () => {
      await nav.current.open.openListed(1)
    })
    expect(nav.current.selected).toBe('c')
  })
})

describe('useOpenNote: pre-opening', () => {
  it('asks for the body before the title and hands it to the editor that shows the note', async () => {
    const { core, calls } = fakeCore(['a'])
    const nav = render({ core, notes: [note('a')], editorTakes: true })
    await select(nav, 'a')
    expect(calls.indexOf('open a')).toBeLessThan(calls.indexOf('title a'))
    expect(taken).toEqual([new Uint8Array([1])])
    expect(calls).not.toContain('unhold a')
  })

  it('lets go of a body no editor took', async () => {
    const { core, calls } = fakeCore(['a'])
    const nav = render({ core, notes: [note('a')] })
    await select(nav, 'a')
    expect(calls.filter((c) => c.endsWith(' a'))).toEqual([
      'hold a',
      'open a',
      'title a',
      'unhold a',
    ])
  })

  it('opens no body ahead for the note already open', async () => {
    const { core, calls } = fakeCore(['a'])
    const nav = render({ core, notes: [note('a')], editorTakes: true })
    await select(nav, 'a')
    calls.length = 0
    await select(nav, 'a')
    expect(calls).toEqual(['flush', 'title a'])
  })
})
