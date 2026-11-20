// @vitest-environment happy-dom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { DEFAULT_EDITOR_SETTINGS } from '../../../core/editorSettings'
import type { Core } from '../core-client'
import type { LinkSources } from '../linkCompletion'
import { editorHandle, makingPause } from './handle'
import { linkOpener } from './lineCommands'
import { newFromSelection } from './noteKeys'
import {
  noteExtensions,
  PAUSED,
  pausedSlot,
  scrollToTop,
  type EditorLock,
  type EditorPlace,
  type NoteEditorRefs,
} from './noteExtensions'

const NOTE = '01890a5d-ac96-774b-bcce-b302099a8057'

const links: LinkSources = {
  find: async () => [],
  create: async () => '',
  discard: async () => {},
  linked: () => {},
}

function refs(overrides: Partial<NoteEditorRefs> = {}): NoteEditorRefs {
  return {
    writing: { current: false },
    menuOpener: { current: () => {} },
    noteOpener: { current: undefined },
    fromSelection: { current: undefined },
    fromLink: { current: undefined },
    linkSources: { current: links },
    templateShown: { current: false },
    chooseTemplate: { current: undefined },
    suggestions: { current: undefined },
    suggestFailed: { current: undefined },
    alertMenu: { current: async () => undefined },
    aiEdit: { current: undefined },
    aiMenu: { current: async () => {} },
    imageHandlers: { current: { open: undefined, menu: undefined } },
    locked: { current: 'none' },
    countsReport: { current: undefined },
    caretLineReport: { current: undefined },
    ...overrides,
  }
}

function noteState(
  body: string,
  editorRefs: NoteEditorRefs,
  placeChanged = () => {},
  settings = DEFAULT_EDITOR_SETTINGS,
) {
  const doc = new Y.Doc()
  const text = doc.getText('body')
  text.insert(0, body)
  const place: EditorPlace = { selection: { anchor: 0, head: 0 } }
  const state = EditorState.create({
    doc: body,
    extensions: noteExtensions(
      {
        core: {} as Core,
        noteId: 'n1',
        doc,
        text,
        settings: { ...settings },
        frame: document.createElement('div'),
        scroller: document.createElement('div'),
        images: { extension: [], choose: () => {}, attach: async () => [] },
        place,
        placeChanged,
        restoring: () => false,
        restoredWrites: () => [],
      },
      editorRefs,
    ),
  })
  return { state, place }
}

describe('noteExtensions', () => {
  it('keeps composition-ending Escape out of Vim before handling ordinary Escape', async () => {
    const { getCM } = await import('@replit/codemirror-vim')
    const { state } = noteState('text', refs(), undefined, {
      ...DEFAULT_EDITOR_SETTINGS,
      vimMode: true,
    })
    const view = new EditorView({ state, parent: document.body })
    const press = (key: string, fields: KeyboardEventInit = {}) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...fields }),
      )
    try {
      await vi.waitFor(() => expect(getCM(view)).not.toBeNull())
      press('i')
      expect(getCM(view)!.state.vim?.insertMode).toBe(true)
      press('Escape', { isComposing: true })
      expect(getCM(view)!.state.vim?.insertMode).toBe(true)
      press('Escape', { keyCode: 229 })
      expect(getCM(view)!.state.vim?.insertMode).toBe(true)
      press('Escape')
      expect(getCM(view)!.state.vim?.insertMode).toBe(false)
    } finally {
      view.destroy()
    }
  })
  it('opens a note link through the opener the editor has when the link is opened', () => {
    const editorRefs = refs()
    const { state } = noteState('text', editorRefs)
    const opened = vi.fn<(id: string) => void>()
    editorRefs.noteOpener.current = opened
    state.facet(linkOpener)?.(`devot://note/${NOTE}`)
    expect(opened).toHaveBeenCalledExactlyOnceWith(NOTE)
  })

  it('offers New Note from Selection only while the window gives it', () => {
    const editorRefs = refs()
    const { state } = noteState('text', editorRefs)
    const run = state.facet(newFromSelection)!
    expect(run()).toBe(false)
    const made = vi.fn<() => void>()
    editorRefs.fromSelection.current = made
    expect(run()).toBe(true)
    expect(made).toHaveBeenCalledOnce()
  })

  it('is read-only for a note shown while locked', () => {
    expect(noteState('text', refs()).state.readOnly).toBe(false)
    expect(noteState('text', refs({ locked: { current: 'readOnly' } })).state.readOnly).toBe(true)
  })

  it('takes no caret either where a read-only text would still raise the keyboard', () => {
    const editable = (locked: EditorLock) =>
      noteState('text', refs({ locked: { current: locked } })).state.facet(EditorView.editable)
    expect(editable('none')).toBe(true)
    expect(editable('readOnly')).toBe(true)
    expect(editable('noKeyboard')).toBe(false)
    expect(noteState('text', refs({ locked: { current: 'noKeyboard' } })).state.readOnly).toBe(true)
  })

  it('reports the place and the caret line as the selection moves', () => {
    const caretLine = vi.fn<(line: number) => void>()
    const placeChanged = vi.fn<() => void>()
    const { state, place } = noteState(
      'one\ntwo\nthree',
      refs({ caretLineReport: { current: caretLine } }),
      placeChanged,
    )
    const view = new EditorView({ state, parent: document.body })
    view.dispatch({ selection: EditorSelection.cursor(9) })
    view.destroy()
    expect(place.selection).toEqual({ anchor: 9, head: 9 })
    expect(placeChanged).toHaveBeenCalledOnce()
    expect(caretLine).toHaveBeenCalledWith(3)
  })
})

describe('scrollToTop', () => {
  interface Measure {
    read: (view: EditorView) => number | undefined
    write?: (top: number | undefined, view: EditorView) => void
  }
  const restoring = () => {
    const requests: Measure[] = []
    const view = {
      documentTop: 0,
      state: EditorState.create({ doc: 'x'.repeat(100) }),
      lineBlockAt: () => ({ top: 500 }),
      requestMeasure: (request: Measure) => requests.push(request),
    } as unknown as EditorView
    const scroller = document.createElement('div')
    const measure = () => {
      for (const request of requests.splice(0)) request.write?.(request.read(view), view)
    }
    return { view, scroller, measure }
  }

  it('puts the line kept at the top back when CodeMirror measures', () => {
    const { view, scroller, measure } = restoring()
    scrollToTop(view, scroller, { pos: 40, offset: 12 })
    measure()
    expect(scroller.scrollTop).toBe(512)
  })

  it('keeps a scroll made before CodeMirror measures', () => {
    const { view, scroller, measure } = restoring()
    scrollToTop(view, scroller, { pos: 40, offset: 12 })
    scroller.scrollTop = 6
    measure()
    expect(scroller.scrollTop).toBe(6)
  })
})

describe('New Note pause', () => {
  const views: EditorView[] = []
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy()
  })

  function shownNote() {
    const view = new EditorView({ state: noteState('Target', refs()).state, parent: document.body })
    views.push(view)
    const shown = { now: true }
    const making = makingPause(view, () => shown.now)
    const handle = editorHandle(
      view,
      new Y.Doc(),
      'n1',
      () => {},
      () => shown.now,
      making,
    )
    return { view, handle, making, shown }
  }

  const takesTyping = (view: EditorView) =>
    view.state.facet(EditorView.editable) &&
    !view.state.readOnly &&
    view.contentDOM.getAttribute('aria-hidden') === null

  it('takes no typing and hides the body until it ends', () => {
    const { view, handle } = shownNote()
    const end = handle.pauseForNewNote()
    expect(takesTyping(view)).toBe(false)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    end()
    expect(takesTyping(view)).toBe(true)
  })

  it('leaves a note switch paused when it ends', () => {
    const { view, handle } = shownNote()
    const end = handle.pauseForNewNote()
    view.dispatch({ effects: pausedSlot.reconfigure(PAUSED) })
    end()
    expect(takesTyping(view)).toBe(false)
  })

  it('leaves a later New Note paused when an earlier one ends', () => {
    const { view, handle } = shownNote()
    const first = handle.pauseForNewNote()
    const second = handle.pauseForNewNote()
    first()
    expect(takesTyping(view)).toBe(false)
    second()
    expect(takesTyping(view)).toBe(true)
  })

  it('ends when the editor shows the note again, and the late end changes nothing', () => {
    const { view, handle, making } = shownNote()
    const end = handle.pauseForNewNote()
    making.end()
    expect(takesTyping(view)).toBe(true)
    view.dispatch({ effects: pausedSlot.reconfigure(PAUSED) })
    end()
    expect(takesTyping(view)).toBe(false)
  })

  it('is cleared by opening another note', () => {
    const { view, handle, shown } = shownNote()
    const end = handle.pauseForNewNote()
    shown.now = false
    view.setState(noteState('Next', refs()).state)
    expect(takesTyping(view)).toBe(true)
    end()
    expect(takesTyping(view)).toBe(true)
  })

  it('pauses nothing once its note is no longer shown', () => {
    const { view, handle, shown } = shownNote()
    shown.now = false
    handle.pauseForNewNote()
    expect(takesTyping(view)).toBe(true)
  })
})
