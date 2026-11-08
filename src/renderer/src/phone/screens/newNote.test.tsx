// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core-client'
import type { EditorHandle } from '../../editor/handle'
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
  handleRef?: { current: EditorHandle | null }
}

// `held` keeps each load back until the test lets it through, as a slow open does.
const editors = vi.hoisted(() => ({ focused: [] as string[], held: null as (() => void)[] | null }))
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
        } as unknown as EditorHandle
      }
      const load = () => latest.current.onLoaded?.('')
      if (editors.held) editors.held.push(load)
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
  editors.held = null
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
const shownStack = () => host.querySelector('.phone-stack:not([hidden])')!
const rows = () => [...shownStack().querySelectorAll<HTMLButtonElement>('.phone-note-open')]
const newNoteButton = () =>
  shownStack().querySelector<HTMLButtonElement>('button[aria-label="New Note"]')

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
async function focus() {
  const asked = bridge.handlers['editor.focus']!({})
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return asked
}

const listed = async (id: string) => (await shell.notes.list()).find((n) => n.id === id)

describe('New Note under the native screens', () => {
  it('leaves the gate and the push to Swift: the capsule only names the notebook', async () => {
    await start()
    await vi.waitFor(() => expect(newNoteButton()).not.toBeNull())
    await act(async () => newNoteButton()!.click())
    expect(notices('note.new')).toStrictEqual([{ notice: 'note.new' }])
    expect(await shell.notes.list()).toStrictEqual([])
    expect(notices('nav.openNote')).toStrictEqual([])
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
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    await act(async () => {
      await shell.notes.setTitle(titled, 'Plans')
      await shell.notes.flush()
    })
    await swift('note.discard', { noteId: left })
    expect(rows().length).toBeLessThan(2)
    await vi.waitFor(async () => expect(await listed(left)).toBeUndefined())
    await swift('note.discard', { noteId: titled })
    expect(await listed(titled)).toBeDefined()
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

  it('refuses a focus Rust would not have passed on', async () => {
    await start()
    await expect(bridge.handlers['editor.show']!({ noteId: 'x', focus: 'title' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    await expect(bridge.handlers['note.discard']!({})).rejects.toThrow('E_SCREENS_ARGS_INVALID')
  })
})
