import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { pluginBlockEdit } from './pluginBlockEdit'

const stateOf = (doc: string, from: number, to = from) =>
  EditorState.create({ doc, selection: EditorSelection.range(from, to), extensions: [history()] })

describe('pluginBlockEdit', () => {
  const doc = 'Intro\n\n```sketch\nold\n```\n'
  const block = { from: 7, to: 24, source: 'old' }

  it('puts the edit in place of the block as one undo step', () => {
    const state = stateOf(doc, 0)
    const spec = pluginBlockEdit(state, block, 'new\r\nline')
    if (!('changes' in spec)) throw new Error('expected a change')
    const after = state.update(spec).state
    expect(after.doc.toString()).toBe('Intro\n\n```sketch\nnew\nline\n```\n')
    expect(undo({ state: after, dispatch: () => {} })).toBe(true)
  })

  it('refuses a block that changed or moved', () => {
    expect(pluginBlockEdit(stateOf(doc.replace('old', 'odd'), 0), block, 'new')).toEqual({
      code: 'E_PLUGIN_NOTE_CHANGED',
    })
    expect(pluginBlockEdit(stateOf('x' + doc, 0), block, 'new')).toEqual({
      code: 'E_PLUGIN_NOTE_CHANGED',
    })
  })
})
