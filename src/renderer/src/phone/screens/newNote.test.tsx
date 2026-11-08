// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BODY } from '../../../../core'
import type { Core } from '../../core-client'
import type { EditorHandle } from '../../editor/handle'
import { changeEditorSettings } from '../../editorSettings'
import { invoke } from '../../ipc'
import { readCurrentLicence } from '../../licence'
import { closePurchase } from '../../purchaseSheet'
import { PhoneApp } from '../PhoneApp'
import { closeGate } from '../requireEditing'
import { setTestCore, testCore } from '../testShell'
import type { ScreensNotice } from './message'
import { noteWritesReported } from './noteChanges'
import type { ScreensHandlers } from './ops'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))
const bridge = vi.hoisted(() => ({
  handlers: {} as ScreensHandlers,
  notices: [] as ScreensNotice[],
}))
vi.mock('./bridge', () => ({
  startScreensBridge: (handlers: ScreensHandlers) => {
    bridge.handlers = handlers
    return {
      installed: Promise.resolve(true),
      notify: (notice: ScreensNotice) => bridge.notices.push(notice),
      stop: () => {},
    }
  },
}))
vi.mock('../../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.0.0' }))
vi.mock('../usePhoneData', async () => ({
  usePhoneData: (await import('../testShell')).useTestPhoneData,
}))

interface EditorProps {
  core: Core
  noteId: string
  onLoaded?: (text: string) => void
  onOpenFailed?: (noteId: string, code: string) => void
  handleRef?: { current: EditorHandle | null }
}

// `held` keeps each load back until the test lets it through, as a slow open does; `fails` opens fail.
const editors = vi.hoisted(() => ({
  focused: [] as string[],
  held: null as (() => void)[] | null,
  fails: false,
  typed: [] as { noteId: string; text: string }[],
}))
vi.mock('../../NoteEditor', () => ({
  NoteEditor: (props: EditorProps) => {
    const { noteId, handleRef } = props
    const latest = useRef(props)
    useEffect(() => {
      latest.current = props
    })
    useEffect(() => {
      if (handleRef) {
        handleRef.current = {
          focusStart: () => editors.focused.push(noteId),
          type: (keys: readonly { key: string }[]) =>
            editors.typed.push({ noteId, text: keys.map((k) => k.key).join('') }),
        } as unknown as EditorHandle
      }
      const load = () => latest.current.onLoaded?.('')
      if (editors.fails) latest.current.onOpenFailed?.(noteId, 'E_STORAGE_READ_FAILED')
      else if (editors.held) editors.held.push(load)
      else load()
    }, [noteId, handleRef])
    return <div className="cm-editor" />
  },
}))
vi.mock('../../preview/Preview', () => ({
  Preview: (props: { markdown: string }) => <div className="preview">{props.markdown}</div>,
}))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const PRO = {
  gated: false,
  state: 'valid',
  code: null,
  id: null,
  licensee: null,
  plan: null,
  trial: null,
  activation: null,
  appStore: null,
}

let host: HTMLDivElement
let root: Root
let shell: ReturnType<typeof testCore>

beforeEach(async () => {
  localStorage.clear()
  bridge.handlers = {}
  bridge.notices = []
  editors.focused = []
  editors.typed = []
  editors.held = null
  editors.fails = false
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? PRO : undefined,
  )
  await readCurrentLicence()
  shell = testCore()
  setTestCore(shell.core)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    closeGate()
    closePurchase()
    root.unmount()
  })
  setTestCore(null)
  host.remove()
  document.body.innerHTML = ''
  vi.mocked(invoke).mockReset()
  vi.restoreAllMocks()
})

const notices = (name: ScreensNotice['notice']) => bridge.notices.filter((n) => n.notice === name)

async function start() {
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => expect(bridge.handlers['note.create']).toBeDefined())
  await act(async () => {
    await bridge.handlers['tabs.show']!({ tab: 'notes' })
  })
}

async function swift(op: keyof ScreensHandlers, args: Record<string, unknown> = {}) {
  let result: unknown
  await act(async () => {
    result = await bridge.handlers[op]!(args)
  })
  return result as Record<string, unknown>
}

// The page focuses in an effect, which `act` runs only once its callback is done.
async function focus(args: Record<string, unknown> = {}) {
  const asked = bridge.handlers['editor.focus']!(args)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return asked
}

const listed = async (id: string) => (await shell.notes.list()).find((n) => n.id === id)

describe('New Note under the native screens', () => {
  it('waits for the core when New Note is asked before the lists are first read', async () => {
    let release: () => void = () => {}
    const flushed = new Promise<void>((resolve) => (release = resolve))
    let held = false
    const core = shell.core
    setTestCore(
      new Proxy(core, {
        get: (target, key) => {
          if (key !== 'flush' || held) return Reflect.get(target, key) as unknown
          held = true
          return () => flushed
        },
      }),
    )
    await act(async () => root.render(<PhoneApp />))
    await vi.waitFor(() => expect(bridge.handlers['note.create']).toBeDefined())
    const made = await swift('note.create', {})
    expect(await listed(made['id'] as string)).toMatchObject({ bookId: null })
    const today = await swift('note.today')
    expect(await listed(today['id'] as string)).toBeDefined()
    release()
  })

  it('puts a note Swift names no notebook for in the Default Notebook', async () => {
    const book = await shell.books.create('Inbox', null)
    await start()
    const unfiled = await swift('note.create', {})
    expect(await listed(unfiled['id'] as string)).toMatchObject({ bookId: null })
    void changeEditorSettings({ defaultNotebook: book }).catch(() => {})
    const filed = await swift('note.create', {})
    expect(await listed(filed['id'] as string)).toMatchObject({ bookId: book })
    expect(notices('note.new')).toStrictEqual([])
  })

  it('makes an empty note with status none in the notebook Swift names', async () => {
    const book = await shell.books.create('Trips', null)
    await start()
    const made = await swift('note.create', { bookId: book })
    const note = await listed(made['id'] as string)
    expect(note).toMatchObject({
      title: '',
      bookId: book,
      status: 'none',
      pinned: false,
      tagIds: [],
    })
    const unfiled = await swift('note.create', {})
    expect(await listed(unfiled['id'] as string)).toMatchObject({ bookId: null, status: 'none' })
  })

  it('counts the change that made the note, so only a later one marks it touched', async () => {
    await start()
    const made = await swift('note.create', {})
    const id = made['id'] as string
    expect(typeof made['rev']).toBe('number')
    act(() => noteWritesReported([id]))
    const [changed] = notices('notes.changed')
    expect(changed).toMatchObject({ notice: 'notes.changed', ids: [id] })
    expect((changed as { rev: number }).rev).toBeGreaterThan(made['rev'] as number)
  })

  it('discards a new note left as made, and keeps one that was given a title', async () => {
    await start()
    const left = (await swift('note.create', {}))['id'] as string
    const titled = (await swift('note.create', {}))['id'] as string
    await act(async () => {
      await shell.notes.setTitle(titled, 'Plans')
      await shell.notes.flush()
    })
    await swift('note.discard', { noteId: left })
    await vi.waitFor(async () => expect(await listed(left)).toBeUndefined())
    expect(await shell.core.listTrash()).toEqual([])
    await swift('note.discard', { noteId: titled })
    expect(await listed(titled)).toBeDefined()
  })

  it('keeps a new note whose status was changed', async () => {
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    await act(async () => {
      await shell.notes.setStatus(id, 'active')
      await shell.notes.flush()
    })
    await swift('note.discard', { noteId: id })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(await listed(id)).toMatchObject({ status: 'active' })
  })

  it('keeps a new note, and logs the refusal by its code, when sync wrote a body into it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    const opened = await shell.notes.open(id)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, opened.state)
    const before = Y.encodeStateVector(doc)
    doc.getText(BODY).insert(0, 'From the Mac')
    await shell.notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
    await swift('note.discard', { noteId: id })
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('W_PHONE_DISCARD_REFUSED code=E_NOTE_NOT_TRASHED'),
    )
    expect(await listed(id)).toBeDefined()
  })

  it('puts the caret in the body only of a note Swift showed to be typed in', async () => {
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    await swift('editor.show', { noteId: id, focus: 'body' })
    await vi.waitFor(() => expect(notices('editor.mode').at(-1)).toMatchObject({ mode: 'edit' }))
    expect(await focus()).toStrictEqual({ focused: true })
    expect(editors.focused).toStrictEqual([id])
    await swift('editor.show', { noteId: id })
    expect(await focus()).toStrictEqual({ focused: false })
    expect(editors.focused).toStrictEqual([id])
  })

  it('types what Swift took before the caret at the start of the body, once it has the caret', async () => {
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    await swift('editor.show', { noteId: id, focus: 'body' })
    await vi.waitFor(() => expect(notices('editor.mode').at(-1)).toMatchObject({ mode: 'edit' }))
    expect(await focus({ typed: 'Shop \u{1F6D2}' })).toStrictEqual({ focused: true })
    expect(editors.focused).toStrictEqual([id])
    expect(editors.typed).toStrictEqual([{ noteId: id, text: 'Shop \u{1F6D2}' }])
    await expect(bridge.handlers['editor.focus']!({ typed: 3 })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
  })

  it('puts the caret in the body of a note that loads long after Swift asked', async () => {
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    editors.held = []
    await swift('editor.show', { noteId: id, focus: 'body' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const asked = bridge.handlers['editor.focus']!({})
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    vi.useRealTimers()
    const loads = editors.held
    editors.held = null
    await act(async () => loads.forEach((load) => load()))
    expect(await asked).toStrictEqual({ focused: true })
    expect(editors.focused).toStrictEqual([id])
  })

  it('takes no caret for a note whose load never comes', async () => {
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    editors.held = []
    await swift('editor.show', { noteId: id, focus: 'body' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const asked = bridge.handlers['editor.focus']!({})
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    vi.useRealTimers()
    expect(await asked).toStrictEqual({ focused: false })
    expect(editors.focused).toStrictEqual([])
  })

  it('takes no caret, and stops waiting at once, for a note whose open failed', async () => {
    await start()
    const id = (await swift('note.create', {}))['id'] as string
    editors.fails = true
    await swift('editor.show', { noteId: id, focus: 'body' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const asked = bridge.handlers['editor.focus']!({})
    await act(async () => {})
    vi.useRealTimers()
    expect(await Promise.race([asked, 'still waiting'])).toStrictEqual({ focused: false })
    expect(editors.focused).toStrictEqual([])
  })

  it('discards a new note an earlier launch made, as that launch says it was made', async () => {
    const book = await shell.books.create('Trips', null)
    const left = await shell.notes.create('', book)
    const moved = await shell.notes.create('', null)
    await shell.notes.flush()
    await start()
    await swift('note.discard', { noteId: left, made: { bookId: book } })
    await vi.waitFor(async () => expect(await listed(left)).toBeUndefined())
    await swift('note.discard', { noteId: moved, made: { bookId: book } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(await listed(moved)).toBeDefined()
  })

  it("finds or makes today's note, the same one twice", async () => {
    await start()
    const first = await swift('note.today')
    const again = await swift('note.today')
    expect(again).toStrictEqual(first)
    expect(Object.keys(first)).toStrictEqual(['id'])
    expect((await listed(first['id'] as string))?.title).not.toBe('')
  })

  it("refuses to make today's note while editing is locked", async () => {
    const ended = { state: 'ended', endsAt: Date.now() - 1, code: null, source: 'keychain' }
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'licence_get' ? { ...PRO, gated: true, state: 'none', trial: ended } : undefined,
    )
    await readCurrentLicence()
    await start()
    await expect(bridge.handlers['note.today']!({})).rejects.toThrow('E_LICENCE_REQUIRED')
    expect(await shell.notes.list()).toStrictEqual([])
  })

  it('refuses a focus Rust would not have passed on', async () => {
    await start()
    await expect(bridge.handlers['editor.show']!({ noteId: 'x', focus: 'title' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    await expect(bridge.handlers['note.discard']!({})).rejects.toThrow('E_SCREENS_ARGS_INVALID')
    for (const made of ['Trips', [], { bookId: '' }, { bookId: null, title: '' }]) {
      await expect(bridge.handlers['note.discard']!({ noteId: 'x', made })).rejects.toThrow(
        'E_SCREENS_ARGS_INVALID',
      )
    }
  })
})
