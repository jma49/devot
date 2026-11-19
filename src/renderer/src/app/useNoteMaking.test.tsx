// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
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
  mode = 'edit',
}: {
  create: () => Promise<string | undefined>
  opens?: boolean
  onEnd?: () => void
  mode?: 'edit' | 'preview'
}) {
  const events: string[] = []
  const handle = {
    noteId: 'shown',
    type: (keys: { key: string }[]) => events.push(`type ${keys.map(({ key }) => key).join('')}`),
    focus: () => events.push('focus'),
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
    createTemplate: create,
    applyTemplate: create,
    openTodaysNote: async () => ({ id: await create(), created: true, bookId: null }),
    duplicate: create,
    saveTemplate: create,
  } as unknown as Core
  const select = vi.fn<(id: string) => Promise<boolean>>(async (id) => {
    events.push(`select ${id}`)
    return opens
  })
  const setMode = vi.fn<(mode: string) => void>()
  const setChangeNotice = vi.fn<(notice: string | undefined) => void>()
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
    modes: { mode, setMode, editorMode: { current: 'edit' } },
    showLibrary: () => {},
    select,
    selected: 'shown',
    setSelected: () => {},
    builtIn: undefined,
    setBuiltIn: () => {},
    setTitle: () => {},
    opens: { current: 0 },
    editorRef: { current: handle },
    setChangeNotice,
    loadHeadlines: undefined,
  } as unknown as Parameters<typeof useNoteMaking>[0]
  const hook = renderHook(useNoteMaking, { props })
  return { events, hook, select, setMode, setChangeNotice, create: () => hook.current.create() }
}

describe('New Note', () => {
  it('pauses the shown note before it waits for the new one', async () => {
    let finish: (id: string) => void = () => {}
    const making = new Promise<string>((resolve) => (finish = resolve))
    const { events, create } = newNoteOver({ create: () => making })
    let creating: Promise<unknown>
    act(() => {
      creating = create()
    })
    expect(events).toEqual(['pause'])
    await act(async () => {
      finish('new')
      await creating
    })
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
    await act(async () => {
      await create()
    })
    expect(events).toEqual(['pause', 'end'])
    expect(focusAtEnd).toEqual([document.body])
    expect(document.activeElement).toBe(body)
  })

  it('ends the pause when the new note does not open', async () => {
    const { events, create } = newNoteOver({
      create: () => Promise.resolve('new'),
      opens: false,
    })
    await act(async () => {
      await create()
    })
    expect(events).toEqual(['pause', 'select new', 'end'])
    takeEarlyKeys('new')
  })
})

describe('create sessions', () => {
  it('ends the body pause and replays keys when the destination is already shown', async () => {
    const { hook, events } = newNoteOver({ create: async () => 'shown' })
    await act(async () => {
      const opening = hook.current.openToday()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', cancelable: true }))
      await opening
    })
    expect(events).toEqual(['pause', 'select shown', 'end', 'type q', 'focus'])
    expect(hook.current.making).toBe(false)
    expect(takeEarlyKeys('shown')).toEqual([])
  })
  it('keeps duplicate failure codes and its notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hook, setChangeNotice } = newNoteOver({
      create: async () => {
        throw new Error('E_DB_LOCKED')
      },
    })
    await act(async () => {
      await hook.current.duplicate('source')
    })
    expect(warn).toHaveBeenCalledWith('W_NOTE_DUPLICATE_FAILED', 'source', 'E_DB_LOCKED')
    expect(setChangeNotice).toHaveBeenCalledExactlyOnceWith('E_DB_LOCKED')
  })

  it.each(['reject', 'empty'])(
    'keeps a built-in copy failure silent apart from its warning (%s)',
    async (result) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { hook, setChangeNotice } = newNoteOver({
        create: async () => {
          if (result === 'reject') throw new Error('E_DB_LOCKED')
          return undefined
        },
      })
      await act(async () => {
        await hook.current.editBuiltInCopy('starter:planning')
      })
      expect(warn).toHaveBeenCalledExactlyOnceWith('W_TEMPLATE_COPY_FAILED', 'starter:planning')
      expect(setChangeNotice).not.toHaveBeenCalled()
    },
  )

  it('warns when applying a template returns no id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hook, setChangeNotice } = newNoteOver({ create: async () => undefined })
    await act(async () => {
      await hook.current.pickBuiltIn('starter:planning')
    })
    expect(warn).toHaveBeenCalledExactlyOnceWith('W_TEMPLATE_APPLY_FAILED', 'starter:planning')
    expect(setChangeNotice).not.toHaveBeenCalled()
  })

  it('keeps the template apply failure notice and both warning codes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hook, setChangeNotice } = newNoteOver({
      create: async () => {
        throw new Error('E_DB_LOCKED')
      },
    })
    await act(async () => {
      await hook.current.pickBuiltIn('starter:planning')
    })
    expect(warn).toHaveBeenCalledWith('W_NOTE_CREATE_FAILED', 'E_DB_LOCKED')
    expect(warn).toHaveBeenCalledWith('W_TEMPLATE_APPLY_FAILED', 'starter:planning')
    expect(setChangeNotice).toHaveBeenCalledExactlyOnceWith('E_DB_LOCKED')
  })

  it.each(['duplicate', 'editBuiltInCopy'] as const)(
    '%s preserves Preview and its keyboard intent',
    async (path) => {
      const { hook, setMode, select, events } = newNoteOver({
        create: async () => 'new',
        mode: 'preview',
      })
      await act(async () => {
        await hook.current[path]('source')
      })
      expect(setMode).not.toHaveBeenCalled()
      expect(select.mock.calls).toEqual([
        path === 'duplicate' ? ['new'] : ['new', { keyboard: true }],
      ])
      expect(events).toEqual(['pause', 'select new'])
      takeEarlyKeys('new')
    },
  )

  it('releases the session on teardown and ignores a late create reply', async () => {
    let finish!: (id: string) => void
    const pending = new Promise<string>((resolve) => (finish = resolve))
    const { hook, events } = newNoteOver({ create: () => pending })
    let creating: Promise<unknown> | undefined
    act(() => {
      creating = hook.current.create()
    })
    hook.unmount()
    await act(async () => {
      finish('new')
      await creating
    })
    expect(events).toEqual(['pause', 'end'])
    expect(takeEarlyKeys('new')).toEqual([])
  })

  it('clears the pause when creation returns no note', async () => {
    const { hook } = newNoteOver({ create: async () => undefined as unknown as string })
    await act(async () => {
      await hook.current.create()
    })
    expect(hook.current.making).toBe(false)
  })
  const paths = ['create', 'pickBuiltIn', 'openToday', 'duplicate', 'editBuiltInCopy'] as const
  for (const path of paths) {
    it(`${path} pauses the pane with its own early-key policy`, async () => {
      let finish!: (id: string) => void
      const pending = new Promise<string>((resolve) => (finish = resolve))
      const { hook } = newNoteOver({ create: () => pending })
      let creating: Promise<unknown> | undefined
      act(() => {
        creating = hook.current[path]('starter:planning')
      })
      expect(hook.current).toHaveProperty('making', true)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true }))
      await act(async () => {
        finish('new')
        await creating
      })
      expect(hook.current).toHaveProperty('making', false)
      expect(takeEarlyKeys('new')).toEqual(path === 'duplicate' ? [] : [{ key: 'x', shift: false }])
    })

    it(`${path} clears the pane pause on failure`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { hook } = newNoteOver({ create: () => Promise.reject(new Error('E_DB_LOCKED')) })
      await act(async () => {
        await hook.current[path]('starter:planning')
      })
      expect(hook.current).toHaveProperty('making', false)
    })
  }
})
