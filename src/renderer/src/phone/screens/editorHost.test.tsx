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
  readOnly?: boolean
  hidden?: boolean
  onLoaded?: (text: string) => void
  onOpenNote?: (id: string) => void
  takePreopened?: (core: Core, noteId: string) => Uint8Array | undefined
  handleRef?: { current: EditorHandle | null }
}

// Like NoteEditor, the stand-in keeps one view for its lifetime and swaps notes into it.
const editors = vi.hoisted(() => ({
  mounts: 0,
  shown: [] as string[],
  bodies: new Map<string, string>(),
  latest: null as EditorProps | null,
  given: [] as string[],
}))
vi.mock('../../NoteEditor', () => ({
  NoteEditor: (props: EditorProps) => {
    const { noteId, core, takePreopened } = props
    const latest = useRef(props)
    useEffect(() => {
      latest.current = props
      editors.latest = props
    })
    useEffect(() => {
      editors.mounts += 1
    }, [])
    useEffect(() => {
      editors.shown.push(noteId)
      if (takePreopened?.(core, noteId)) editors.given.push(noteId)
      latest.current.onLoaded?.(editors.bodies.get(noteId) ?? '')
    }, [noteId, core, takePreopened])
    return <div className="cm-editor" hidden={props.hidden} />
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
const ENDED = {
  ...PRO,
  gated: true,
  state: 'none',
  trial: { state: 'ended', endsAt: Date.now() - 1, code: null, source: 'keychain' },
}

let host: HTMLDivElement
let root: Root
let shell: ReturnType<typeof testCore>
let licence: unknown

beforeEach(async () => {
  localStorage.clear()
  bridge.handlers = {}
  bridge.notices = []
  editors.mounts = 0
  editors.shown = []
  editors.bodies.clear()
  editors.latest = null
  editors.given = []
  licence = PRO
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'licence_get' ? licence : undefined,
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

const editorHost = () => host.querySelector<HTMLElement>('.phone-editor-host')!
const noteScreen = () => editorHost().querySelector('section')
const notices = (name: ScreensNotice['notice']) => bridge.notices.filter((n) => n.notice === name)
const shownStack = () => host.querySelector('.phone-stack:not([hidden])')!
const rows = () => [...shownStack().querySelectorAll<HTMLButtonElement>('.phone-note-open')]
const layer = (mode: 'edit' | 'preview') =>
  editorHost().querySelector<HTMLElement>(
    mode === 'edit' ? '.phone-note-layer:not(.phone-note-preview)' : '.phone-note-preview',
  )!

async function start() {
  await act(async () => root.render(<PhoneApp />))
  await vi.waitFor(() => expect(bridge.handlers['editor.show']).toBeDefined())
  await act(async () => {
    await bridge.handlers['tabs.show']!({ tab: 'notes' })
  })
}

async function swift(op: keyof ScreensHandlers, args: Record<string, unknown> = {}) {
  let result: unknown
  await act(async () => {
    result = await bridge.handlers[op]!(args)
  })
  return result
}

const nextFrames = () =>
  act(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

describe('the editor host under the native screens', () => {
  it('asks Swift to push a note a row opens, and pushes no web screen', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    await act(async () => rows()[0]!.click())
    expect(notices('nav.openNote')).toStrictEqual([
      { notice: 'nav.openNote', noteId: id, title: 'Plans' },
    ])
    expect(shownStack().querySelectorAll('.phone-layer')).toHaveLength(1)
    expect(editorHost().dataset['shown']).toBeUndefined()
  })

  it('opens a row’s note ahead of the push when the finger touches it', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    await act(async () => {
      rows()[0]!
        .closest('.phone-note-content')!
        .dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 1,
            clientX: 20,
            clientY: 20,
          }),
        )
      await shell.notes.flush()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await swift('editor.show', { noteId: id })
    expect(editors.given).toStrictEqual([id])
  })

  it('shows the note Swift names, without the web top bar, and swaps notes into one editor', async () => {
    const first = await shell.notes.create('First', null)
    const second = await shell.notes.create('Second', null)
    await start()
    await swift('editor.show', { noteId: first })
    expect(editorHost().dataset['shown']).toBe('')
    expect(noteScreen()?.getAttribute('aria-label')).toBe('First')
    expect(editorHost().querySelector('.phone-topbar')).toBeNull()
    await swift('editor.show', { noteId: second })
    expect(noteScreen()?.getAttribute('aria-label')).toBe('Second')
    expect(editors.shown).toStrictEqual([first, second])
    expect(editors.mounts).toBe(1)
  })

  it('reports the note ready only after it has painted', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    expect(notices('editor.ready')).toStrictEqual([])
    await nextFrames()
    await vi.waitFor(() =>
      expect(notices('editor.ready')).toStrictEqual([{ notice: 'editor.ready', noteId: id }]),
    )
    await swift('editor.hide')
    await swift('editor.show', { noteId: id })
    await nextFrames()
    await vi.waitFor(() => expect(notices('editor.ready')).toHaveLength(2))
  })

  it('hides the editor and answers once the list is painted again', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    let answered = false
    let hidden: Promise<void> = Promise.resolve()
    await act(async () => {
      hidden = bridge.handlers['editor.hide']!({}).then(() => {
        answered = true
      })
    })
    expect(editorHost().dataset['shown']).toBeUndefined()
    expect(editorHost().inert).toBe(true)
    expect(answered).toBe(false)
    await act(() => hidden)
    expect(answered).toBe(true)
  })

  it('keeps Preview drawn behind Edit, and crossfades with transforms and opacity only', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    expect(notices('editor.mode').at(-1)).toStrictEqual({
      notice: 'editor.mode',
      noteId: id,
      mode: 'edit',
    })
    expect(layer('preview').querySelector('.preview')).not.toBeNull()
    expect(layer('preview').inert).toBe(true)
    const animate = vi.spyOn(Element.prototype, 'animate')
    await swift('editor.setMode', { mode: 'preview' })
    expect(notices('editor.mode').at(-1)).toMatchObject({ mode: 'preview' })
    expect(layer('preview').inert).toBe(false)
    expect(layer('edit').inert).toBe(true)
    const moved = new Set(animate.mock.instances.map((el) => el as unknown as Element))
    expect(moved).toStrictEqual(new Set([layer('edit'), layer('preview')]))
    for (const [keyframes, options] of animate.mock.calls) {
      for (const frame of keyframes as Keyframe[]) {
        expect(Object.keys(frame).filter((key) => key !== 'offset')).toSatisfy((keys: string[]) =>
          keys.every((key) => key === 'transform' || key === 'opacity'),
        )
      }
      expect(String((options as KeyframeAnimationOptions).easing)).toMatch(/^cubic-bezier\(/)
    }
    expect(
      animate.mock.calls.some(
        ([, options]) => (options as KeyframeAnimationOptions).composite === 'add',
      ),
    ).toBe(true)
  })

  it('opens a locked note in Preview, read-only, and keeps it there', async () => {
    const id = await shell.notes.create('Plans', null)
    licence = ENDED
    await readCurrentLicence()
    await start()
    await swift('editor.show', { noteId: id })
    expect(notices('editor.mode').at(-1)).toMatchObject({ noteId: id, mode: 'preview' })
    expect(editors.latest?.readOnly).toBe(true)
    await swift('editor.setMode', { mode: 'edit' })
    expect(notices('editor.mode').at(-1)).toMatchObject({ mode: 'preview' })
    expect(layer('preview').inert).toBe(false)
  })

  it('sends a link to Swift, which pushes the linked note over this one', async () => {
    const first = await shell.notes.create('First', null)
    const second = await shell.notes.create('Second', null)
    await start()
    await swift('editor.show', { noteId: first })
    await act(async () => editors.latest!.onOpenNote!(second))
    expect(notices('nav.openNote').at(-1)).toStrictEqual({
      notice: 'nav.openNote',
      noteId: second,
      title: 'Second',
    })
    expect(noteScreen()?.getAttribute('aria-label')).toBe('First')
  })

  it('opens Note Info when Swift asks', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    await swift('editor.info')
    expect(document.querySelector('.phone-sheet-layer [role="dialog"]')).not.toBeNull()
    await swift('editor.hide')
    expect(document.querySelector('.phone-sheet-layer [role="dialog"]')).toBeNull()
  })

  it('refuses a request without a note or with an unknown mode', async () => {
    await start()
    await expect(bridge.handlers['editor.show']!({})).rejects.toThrow('E_SCREENS_ARGS_INVALID')
    await expect(bridge.handlers['editor.setMode']!({ mode: 'write' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
  })
})
