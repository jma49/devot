// @vitest-environment happy-dom
import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  acceptSpec,
  ghostField,
  ghostText,
  showGhost,
  suggestAt,
  waitingField,
  type GhostSource,
} from './ghostText'

function shown(doc: string, caret: number, text: string): EditorState {
  const base = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [ghostField, history()],
  })
  return base.update({ effects: showGhost(caret, text) }).state
}

describe('the ghost text', () => {
  it('is not part of the document', () => {
    const state = shown('We plan', 7, ' to ship.')
    expect(state.doc.toString()).toBe('We plan')
    expect(state.field(ghostField)).toEqual({ pos: 7, text: ' to ship.' })
  })

  it('goes when the text changes or the caret moves', () => {
    const state = shown('We plan', 7, ' to ship.')
    expect(state.update({ changes: { from: 7, insert: '!' } }).state.field(ghostField)).toBeNull()
    expect(state.update({ selection: { anchor: 3 } }).state.field(ghostField)).toBeNull()
    expect(
      state.update({ selection: EditorSelection.single(7) }).state.field(ghostField),
    ).toBeNull()
  })

  it('stays through a transaction that changes neither', () => {
    const state = shown('We plan', 7, ' to ship.')
    expect(state.update({ scrollIntoView: true }).state.field(ghostField)).not.toBeNull()
  })

  it('has nothing to accept without a suggestion', () => {
    const state = EditorState.create({ doc: 'We plan', extensions: [ghostField] })
    expect(acceptSpec(state)).toBeNull()
  })

  it('is accepted as text after the caret, and undone in one step', () => {
    let state = shown('We plan', 7, ' to ship.')
    const spec = acceptSpec(state)!
    state = state.update(spec).state
    expect(state.doc.toString()).toBe('We plan to ship.')
    expect(state.selection.main.head).toBe(16)
    expect(state.field(ghostField)).toBeNull()
    const view = {
      get state() {
        return state
      },
      dispatch: (tr: Parameters<EditorState['update']>[0]) => {
        state = state.update(tr).state
      },
    } as unknown as EditorView
    expect(undo(view)).toBe(true)
    expect(state.doc.toString()).toBe('We plan')
  })
})

function asking() {
  let answer: (text: string | null) => void = () => {}
  let sent: () => void = () => {}
  const source: GhostSource = {
    suggest: (_context, _trigger, onSent) => {
      sent = onSent
      return new Promise((resolve) => (answer = resolve))
    },
    cancel: () => {},
    failed: () => {},
  }
  const view = new EditorView({
    state: EditorState.create({
      doc: 'We plan',
      selection: { anchor: 7 },
      extensions: ghostText(source),
    }),
  })
  return { view, answer: (text: string | null) => answer(text), sent: () => sent() }
}

describe('the waiting mark', () => {
  it('shows only once the request leaves, and goes with the answer', async () => {
    const { view, answer, sent } = asking()
    expect(suggestAt(view)).toBe(true)
    expect(view.state.field(waitingField)).toBeNull()
    sent()
    expect(view.state.field(waitingField)).toBe(7)
    expect(view.contentDOM.querySelector('.cm-ghost-waiting')).not.toBeNull()
    answer(' to ship.')
    await expect.poll(() => view.state.field(ghostField)).toEqual({ pos: 7, text: ' to ship.' })
    expect(view.state.field(waitingField)).toBeNull()
    expect(view.contentDOM.querySelector('.cm-ghost-waiting')).toBeNull()
    view.destroy()
  })

  it('goes when the user types, and a late answer shows nothing', async () => {
    const { view, answer, sent } = asking()
    suggestAt(view)
    sent()
    view.dispatch({ changes: { from: 7, insert: '!' }, selection: { anchor: 8 } })
    expect(view.state.field(waitingField)).toBeNull()
    answer(' to ship.')
    await Promise.resolve()
    expect(view.state.field(ghostField)).toBeNull()
    view.destroy()
  })

  it('goes with Escape', () => {
    const { view, sent } = asking()
    suggestAt(view)
    sent()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(view.state.field(waitingField)).toBeNull()
    view.destroy()
  })
})
