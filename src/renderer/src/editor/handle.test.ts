// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { editorHandle } from './handle'
import { makingSlot, PAUSED, pausedSlot } from './noteExtensions'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function shownNote() {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'Target',
      extensions: [pausedSlot.of([]), makingSlot.of([])],
    }),
    parent: document.body,
  })
  views.push(view)
  const shown = { now: true }
  const handle = editorHandle(
    view,
    new Y.Doc(),
    'note',
    () => {},
    () => shown.now,
  )
  return { view, handle, shown }
}

const takesTyping = (view: EditorView) =>
  view.state.facet(EditorView.editable) && !view.state.readOnly

describe('pauseForNewNote', () => {
  it('takes no typing and hides the body until it ends', () => {
    const { view, handle } = shownNote()
    const end = handle.pauseForNewNote()
    expect(takesTyping(view)).toBe(false)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(view.contentDOM.getAttribute('aria-hidden')).toBe('true')
    end()
    expect(takesTyping(view)).toBe(true)
    expect(view.contentDOM.getAttribute('aria-hidden')).toBeNull()
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

  it('pauses nothing once its note is no longer shown', () => {
    const { view, handle, shown } = shownNote()
    shown.now = false
    view.setState(
      EditorState.create({ doc: 'Next', extensions: [pausedSlot.of([]), makingSlot.of([])] }),
    )
    handle.pauseForNewNote()
    expect(takesTyping(view)).toBe(true)
  })
})
