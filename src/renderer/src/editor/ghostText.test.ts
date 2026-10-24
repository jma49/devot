import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { acceptSpec, ghostField, showGhost } from './ghostText'

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
