// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../core-client'
import type { EditorHandle } from '../../editor/handle'
import type { FindOptions } from '../../../../core/find'
import type { FindTarget } from '../../find/target'
import { invoke } from '../../ipc'
import { readCurrentLicence } from '../../licence'
import { closePurchase } from '../../purchaseSheet'
import { haptic } from '../haptics'
import { PhoneApp } from '../PhoneApp'
import { closeGate } from '../requireEditing'
import { setTestCore, testCore } from '../testShell'
import type { ScreensNotice } from './message'
import type { ScreensHandlers } from './ops'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))
const bridge = vi.hoisted(() => ({
  handlers: {} as ScreensHandlers,
  notices: [] as ScreensNotice[],
  installed: null as Promise<boolean> | null,
}))
vi.mock('./bridge', () => ({
  startScreensBridge: (handlers: ScreensHandlers) => {
    bridge.handlers = handlers
    return {
      installed: bridge.installed ?? Promise.resolve(true),
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
  onFind?: (target: FindTarget | null) => void
}

const searchable = (searched: string[] = []) =>
  ({
    search: (options: FindOptions) => searched.push(options.query),
    next: () => {},
    previous: () => {},
    clear: () => {},
    status: () => ({ total: 2, current: 0, capped: false }),
  }) as unknown as FindTarget

// Like NoteEditor, the stand-in keeps one view for its lifetime and swaps notes into it.
const editors = vi.hoisted(() => ({
  mounts: 0,
  shown: [] as string[],
  bodies: new Map<string, string>(),
  latest: null as EditorProps | null,
  given: [] as string[],
  findTarget: null as FindTarget | null,
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
      if (editors.findTarget) latest.current.onFind?.(editors.findTarget)
    }, [noteId, core, takePreopened])
    return <div className="cm-editor" hidden={props.hidden} />
  },
}))
const previews = vi.hoisted(() => [] as { frontMatterInInfo?: boolean }[])
vi.mock('../../preview/Preview', async (actual) => ({
  previewNote: (await actual<typeof import('../../preview/Preview')>()).previewNote,
  Preview: (props: { markdown: string; frontMatterInInfo?: boolean }) => {
    previews.push(props)
    return <div className="preview">{props.markdown}</div>
  },
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
  bridge.installed = null
  editors.mounts = 0
  editors.shown = []
  editors.bodies.clear()
  editors.latest = null
  editors.given = []
  editors.findTarget = searchable()
  previews.length = 0
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
const layer = (mode: 'edit' | 'preview') =>
  editorHost().querySelector<HTMLElement>(
    mode === 'edit' ? '.phone-note-layer:not(.phone-note-preview)' : '.phone-note-preview',
  )!

const summary = async (id: string) =>
  (await shell.core.listWithTemplates()).notes.find((note) => note.id === id)

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
  it('opens a note ahead of the push when Swift says its row was pressed', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await act(async () => {
      await bridge.handlers['editor.prepare']!({ noteId: id })
      await shell.notes.flush()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await swift('editor.show', { noteId: id })
    expect(editors.given).toStrictEqual([id])
    await expect(bridge.handlers['editor.prepare']!({})).rejects.toThrow('E_SCREENS_ARGS_INVALID')
  })

  // The bridge runs the requests Swift made before it attached at once, before the host mounts.
  it('shows a note Swift asked for before the editor host mounted', async () => {
    const id = await shell.notes.create('Plans', null)
    let attach: (installed: boolean) => void = () => {}
    bridge.installed = new Promise((resolve) => (attach = resolve))
    await act(async () => root.render(<PhoneApp />))
    await vi.waitFor(() => expect(bridge.handlers['editor.show']).toBeDefined())
    expect(host.querySelector('.phone-editor-host')).toBeNull()
    let shown: Promise<unknown> = Promise.resolve()
    await act(async () => {
      shown = bridge.handlers['editor.show']!({ noteId: id })
      attach(true)
    })
    await act(async () => {
      await shown
    })
    expect(editorHost().dataset['shown']).toBe('')
    expect(noteScreen()?.getAttribute('aria-label')).toBe('Plans')
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

  it('reports the mode, the title and the title’s place again for each screen that shows the note', async () => {
    const id = await shell.notes.create('Plans', null)
    editors.bodies.set(id, 'Read me')
    await start()
    await swift('editor.show', { noteId: id })
    const before = {
      mode: notices('editor.mode').length,
      title: notices('editor.title').length,
      scroll: notices('editor.scroll').length,
    }
    expect(notices('editor.mode').at(-1)).toMatchObject({ noteId: id, mode: 'preview' })
    await swift('editor.hide')
    await swift('editor.show', { noteId: id })
    expect(notices('editor.mode')).toHaveLength(before.mode + 1)
    expect(notices('editor.mode').at(-1)).toMatchObject({ noteId: id, mode: 'preview' })
    expect(notices('editor.title')).toHaveLength(before.title + 1)
    expect(notices('editor.scroll')).toHaveLength(before.scroll + 1)
  })

  it('opens the note at its top on each show, even the note shown last', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    // The shown note scrolls the page itself (pageScroll.ts).
    expect(document.documentElement.hasAttribute('data-page-scrolls')).toBe(true)
    const scrollTo = vi.spyOn(window, 'scrollTo')
    await swift('editor.hide')
    expect(document.documentElement.hasAttribute('data-page-scrolls')).toBe(false)
    await swift('editor.show', { noteId: id })
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
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

  it('rests the hidden pane again when the note changes during a crossfade', async () => {
    const first = await shell.notes.create('First', null)
    const second = await shell.notes.create('Second', null)
    editors.bodies.set(second, 'Read me')
    await start()
    await swift('editor.show', { noteId: first })
    const finishes: (() => void)[] = []
    vi.spyOn(Element.prototype, 'animate').mockImplementation(() => {
      const finished = new Promise<void>((resolve) => finishes.push(resolve))
      return { finished, cancel: () => {} } as unknown as Animation
    })
    await swift('editor.setMode', { mode: 'preview' })
    expect(finishes.length).toBeGreaterThan(0)
    await swift('editor.show', { noteId: second })
    expect(notices('editor.mode').at(-1)).toMatchObject({ noteId: second, mode: 'preview' })
    await act(async () => {
      for (const finish of finishes) finish()
    })
    expect(layer('edit').dataset['resting']).toBe('true')
    expect(editors.latest?.hidden).toBe(true)
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

  it('sends Swift the chips’ taps for its pickers', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    const chips = [...editorHost().querySelectorAll<HTMLButtonElement>('.phone-chip-target')]
    await act(async () => chips[0]!.click())
    await act(async () => chips[1]!.click())
    await act(async () => chips.at(-1)!.click())
    expect(notices('editor.picker').map((n) => n.notice === 'editor.picker' && n.picker)).toEqual([
      'notebook',
      'status',
      'tags',
    ])
    expect(document.querySelector('.phone-sheet-layer [role="dialog"]')).toBeNull()
  })

  it('tells Swift the facts of each note it shows, for the More menu and the pickers', async () => {
    const book = await shell.books.create('Work', null)
    const id = await shell.notes.create('Plans', book)
    const tagId = await shell.tags.addToNote(id, 'urgent')
    await shell.notes.setPinned(id, true)
    const other = await shell.notes.create('Other', null)
    await start()
    await swift('editor.show', { noteId: id })
    await vi.waitFor(() =>
      expect(notices('editor.note').at(-1)).toMatchObject({
        id,
        bookId: book,
        status: 'none',
        pinned: true,
        tagIds: [tagId],
      }),
    )
    await swift('editor.show', { noteId: other })
    await vi.waitFor(() =>
      expect(notices('editor.note').at(-1)).toMatchObject({ id: other, bookId: null, tagIds: [] }),
    )
  })

  it('makes a tag by name on the note the tags picker shows', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    const made = (await swift('note.addTag', { noteId: id, name: 'urgent' })) as { tagId: string }
    expect((await summary(id))?.tagIds).toEqual([made.tagId])
  })

  it('drives Find, formatting and the suggestion on the shown note', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    expect(await swift('editor.find', { action: 'search', query: 'x' })).toMatchObject({ total: 2 })
    // A locked note searches too: Find shows the editor, which takes no caret.
    expect(notices('editor.mode').at(-1)).toMatchObject({ mode: 'edit' })
    await swift('editor.find', { action: 'close' })
    await expect(bridge.handlers['editor.format']!({ id: 'strike' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    await expect(bridge.handlers['editor.ai']!({ action: 'write' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
  })

  it('runs a search asked for before the note can be searched once it can, the latest query only', async () => {
    const id = await shell.notes.create('Plans', null)
    editors.findTarget = null
    await start()
    await swift('editor.show', { noteId: id })
    const searched: string[] = []
    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = bridge.handlers['editor.find']!({ action: 'search', query: 'c' })
      second = bridge.handlers['editor.find']!({ action: 'search', query: 'ca' })
    })
    await act(async () => editors.latest!.onFind!(searchable(searched)))
    expect(await first).toStrictEqual({ total: 0, current: 0, capped: false })
    expect(await second).toStrictEqual({ total: 2, current: 1, capped: false })
    expect(searched).toStrictEqual(['ca'])
    expect(await swift('editor.find', { action: 'search', query: 'cat' })).toMatchObject({
      total: 2,
    })
    expect(searched).toStrictEqual(['ca', 'cat'])
  })

  it('formats only while editing is allowed, and asks for Devot Pro otherwise', async () => {
    const id = await shell.notes.create('Plans', null)
    const format = vi.fn<(id: string) => void>()
    await start()
    await swift('editor.show', { noteId: id })
    act(() => {
      editors.latest!.handleRef!.current = { format } as unknown as EditorHandle
    })
    await swift('editor.format', { id: 'bold' })
    expect(format).toHaveBeenCalledWith('bold')
    licence = ENDED
    await act(async () => {
      await readCurrentLicence()
    })
    await swift('editor.format', { id: 'italic' })
    expect(format).toHaveBeenCalledTimes(1)
    expect(notices('editor.haptic').at(-1)).toStrictEqual({
      notice: 'editor.haptic',
      kind: 'warning',
    })
  })

  it('duplicates the shown note with its tags, and answers with the copy', async () => {
    const id = await shell.notes.create('Plans', null)
    await shell.tags.addToNote(id, 'urgent')
    await start()
    await swift('editor.show', { noteId: id })
    const made = (await swift('editor.duplicate')) as { id: string; title: string }
    expect(made.id).not.toBe(id)
    expect(made.title).toBe('Plans copy')
    expect((await summary(made.id))?.tagIds).toHaveLength(1)
  })

  it('answers Note Info with the counts, the revisions, the backlinks and no front matter', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    expect(await swift('note.info', { noteId: id })).toStrictEqual({
      words: 0,
      characters: 0,
      readingMinutes: 1,
      revisions: 0,
      backlinks: [],
      frontMatter: null,
    })
  })

  it('answers Note Info with the front matter rows and what differs from the note', async () => {
    const id = await shell.notes.create('Plans', null)
    await shell.tags.addToNote(id, 'work')
    await shell.notes.setBody(
      id,
      '---\ntitle: Trip\nstatus: active\ntags: [work]\nwhere: Oslo\n---\nBody',
    )
    await shell.notes.flush()
    await start()
    const info = (await swift('note.info', { noteId: id })) as { frontMatter: unknown }
    expect(info.frontMatter).toStrictEqual({
      kind: 'properties',
      rows: [
        {
          key: 'title',
          value: { kind: 'text', text: 'Trip' },
          difference: { field: 'title', badge: 'Note: Plans', value: 'Trip' },
        },
        {
          key: 'status',
          value: { kind: 'text', text: 'active' },
          difference: { field: 'status', badge: 'Note: No Status', value: 'active' },
        },
        { key: 'tags', value: { kind: 'chips', chips: [{ name: 'work' }] } },
        { key: 'where', value: { kind: 'text', text: 'Oslo' } },
      ],
    })
  })

  it('applies the front matter’s title, status and tags to the note', async () => {
    const id = await shell.notes.create('Plans', null)
    await shell.tags.addToNote(id, 'old')
    await start()
    await swift('note.applyFrontMatter', { noteId: id, field: 'title', value: 'Trip' })
    await swift('note.applyFrontMatter', { noteId: id, field: 'status', value: 'active' })
    await swift('note.applyFrontMatter', { noteId: id, field: 'tags', value: '["work","Old"]' })
    await shell.notes.flush()
    const applied = await summary(id)
    expect(applied?.title).toBe('Trip')
    expect(applied?.status).toBe('active')
    const names = (await shell.tags.list())
      .filter((tag) => applied?.tagIds.includes(tag.id))
      .map((tag) => tag.name)
    expect(names.sort()).toStrictEqual(['old', 'work'])
  })

  it('refuses a front matter change the preview would not have offered', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await expect(
      bridge.handlers['note.applyFrontMatter']!({ noteId: id, field: 'status', value: 'later' }),
    ).rejects.toThrow('E_SCREENS_ARGS_INVALID')
    await expect(
      bridge.handlers['note.applyFrontMatter']!({ noteId: id, field: 'tags', value: '{"a":1}' }),
    ).rejects.toThrow('E_SCREENS_ARGS_INVALID')
  })

  it('leaves the front matter out of the preview under the native screens', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('editor.show', { noteId: id })
    expect(previews.at(-1)?.frontMatterInInfo).toBe(true)
  })

  it('sets the dates Note Info picks', async () => {
    const id = await shell.notes.create('Plans', null)
    await start()
    await swift('note.setDates', { noteId: id, createdAt: 1_000 })
    expect((await summary(id))?.createdAt).toBe(1_000)
  })

  it('hands the page’s haptics to Swift', async () => {
    await start()
    await act(async () => haptic('selection'))
    expect(notices('editor.haptic')).toStrictEqual([{ notice: 'editor.haptic', kind: 'selection' }])
  })

  it('drops a format held by the gate once the screen it was asked on goes', async () => {
    const id = await shell.notes.create('Plans', null)
    const format = vi.fn<(id: string) => void>()
    licence = ENDED
    await readCurrentLicence()
    await start()
    await swift('editor.show', { noteId: id })
    act(() => {
      editors.latest!.handleRef!.current = { format } as unknown as EditorHandle
    })
    await swift('editor.format', { id: 'bold' })
    await swift('editor.hide')
    licence = PRO
    await act(async () => void (await readCurrentLicence()))
    await nextFrames()
    expect(format).not.toHaveBeenCalled()
  })

  it('refuses a request without a note or with an unknown mode', async () => {
    await start()
    await expect(bridge.handlers['editor.show']!({})).rejects.toThrow('E_SCREENS_ARGS_INVALID')
    await expect(bridge.handlers['editor.setMode']!({ mode: 'write' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
  })
})
