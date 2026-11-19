// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../../core'
import type { Core } from '../core-client'
import { takeEarlyKeys } from '../editor/earlyKeys'
import type { EditorHandle } from '../editor/handle'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { useNoteMaking } from './useNoteMaking'

afterEach(() => {
  unmountAll()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const made: NoteSummary = {
  id: 'new',
  title: '',
  createdAt: 1,
  updatedAt: 1,
  bodyVersion: 0,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
}

/** New Note over a shown note whose handle records its pauses; `opens` is what selecting the new note answers. */
function newNoteOver({
  create,
  opens = true,
  onEnd = () => {},
}: {
  create: () => Promise<string>
  opens?: boolean
  onEnd?: () => void
}) {
  const events: string[] = []
  const handle = {
    noteId: 'shown',
    pauseForNewNote: () => {
      events.push('pause')
      return () => {
        onEnd()
        events.push('end')
      }
    },
  } as unknown as EditorHandle
  const core = {
    flush: () => Promise.resolve(),
    create,
  } as unknown as Core
  const select = vi.fn<(id: string) => Promise<boolean>>(async (id) => {
    events.push(`select ${id}`)
    return opens
  })
  const props = {
    core,
    editing: true,
    lists: {
      refresh: async () => ({ notes: [made], templates: [], books: [] }),
      notes: [],
      templates: [],
      books: [],
    },
    view: {
      inTrash: false,
      inTemplates: false,
      libraryBook: undefined,
      activeFilter: null,
      workspaceIds: undefined,
      setWorkspace: () => {},
      locales: [],
    },
    searchState: { latestSearch: { current: { query: '', scope: 'all' } } },
    modes: { mode: 'edit', setMode: () => {}, editorMode: { current: 'edit' } },
    showLibrary: () => {},
    select,
    selected: 'shown',
    setSelected: () => {},
    builtIn: undefined,
    setBuiltIn: () => {},
    setTitle: () => {},
    opens: { current: 0 },
    editorRef: { current: handle },
    setChangeNotice: () => {},
    loadHeadlines: undefined,
  } as unknown as Parameters<typeof useNoteMaking>[0]
  const hook = renderHook(useNoteMaking, { props })
  return { events, create: () => hook.current.create() }
}

describe('New Note', () => {
  it('pauses the shown note before it waits for the new one', async () => {
    let finish: (id: string) => void = () => {}
    const making = new Promise<string>((resolve) => (finish = resolve))
    const { events, create } = newNoteOver({ create: () => making })
    const creating = create()
    expect(events).toEqual(['pause'])
    finish('new')
    await creating
    expect(events).toEqual(['pause', 'select new'])
    takeEarlyKeys('new')
  })

  it('ends the pause when the note is not made, before the keyboard goes back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = document.createElement('textarea')
    document.body.append(body)
    body.focus()
    const focusAtEnd: (Element | null)[] = []
    const { events, create } = newNoteOver({
      create: () => Promise.reject(new Error('E_DB_LOCKED')),
      onEnd: () => focusAtEnd.push(document.activeElement),
    })
    await create()
    expect(events).toEqual(['pause', 'end'])
    expect(focusAtEnd).toEqual([document.body])
    expect(document.activeElement).toBe(body)
  })

  it('ends the pause when the new note does not open', async () => {
    const { events, create } = newNoteOver({
      create: () => Promise.resolve('new'),
      opens: false,
    })
    await create()
    expect(events).toEqual(['pause', 'select new', 'end'])
    takeEarlyKeys('new')
  })
})
