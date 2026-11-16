import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES } from '../../../core/noteLimits'
import { pluginInsert, pluginSelection } from './pluginText'

const stateOf = (doc: string, from: number, to = from) =>
  EditorState.create({ doc, selection: EditorSelection.range(from, to), extensions: [history()] })

describe('pluginSelection', () => {
  it('gives the main selection in document order with its text', () => {
    expect(pluginSelection(stateOf('one two three', 8, 4))).toEqual({
      from: 4,
      to: 8,
      text: 'two ',
    })
  })

  it('gives an empty text at the caret', () => {
    expect(pluginSelection(stateOf('abc', 2))).toEqual({ from: 2, to: 2, text: '' })
  })
})

describe('pluginInsert', () => {
  it('replaces the selection and leaves the caret after the text, as one undo step', () => {
    const state = stateOf('one two three', 4, 7)
    const spec = pluginInsert(state, 'TWO', null)
    if (!('changes' in spec)) throw new Error('expected a change')
    const after = state.update(spec).state
    expect(after.doc.toString()).toBe('one TWO three')
    expect(after.selection.main.head).toBe(7)
    let undone = after
    undo({ state: after, dispatch: (tr) => (undone = tr.state) })
    expect(undone.doc.toString()).toBe('one two three')
  })

  it('writes line feeds only', () => {
    const state = stateOf('ab', 1)
    const spec = pluginInsert(state, 'x\r\ny', null)
    if (!('changes' in spec)) throw new Error('expected a change')
    expect(state.update(spec).state.doc.toString()).toBe('ax\nyb')
  })

  it('inserts at the caret', () => {
    const state = stateOf('ab', 1)
    const spec = pluginInsert(state, 'X', null)
    if (!('changes' in spec)) throw new Error('expected a change')
    expect(state.update(spec).state.doc.toString()).toBe('aXb')
  })

  it('refuses when the selection no longer holds the text the plugin read', () => {
    expect(pluginInsert(stateOf('one two', 0, 3), 'x', 'two')).toEqual({
      code: 'E_PLUGIN_NOTE_CHANGED',
    })
    expect('changes' in pluginInsert(stateOf('one two', 0, 3), 'x', 'one')).toBe(true)
  })

  it('refuses a result over the note size limit', () => {
    const state = stateOf('a'.repeat(MAX_BODY_BYTES - 1), 0)
    expect(pluginInsert(state, 'bb', null)).toEqual({ code: 'E_NOTE_BODY_TOO_LARGE' })
    expect('changes' in pluginInsert(state, 'b', null)).toBe(true)
  })
})
