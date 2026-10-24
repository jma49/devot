import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { AI_EDIT_PRESETS } from '../../../core/aiEdit'
import { AI_MENU, aiEditStart } from './aiMenu'

describe('the AI menu', () => {
  it('offers every preset once, then a custom instruction', () => {
    const choices = AI_MENU.flat().map((entry) => entry.action)
    expect([...choices].sort()).toEqual([...AI_EDIT_PRESETS, 'prompt'].sort())
    expect(choices.at(-1)).toBe('prompt')
  })

  it('starts from the main selection, never from a caret or white space', () => {
    const at = (from: number, to: number) =>
      EditorState.create({ doc: 'one two \n', selection: EditorSelection.range(from, to) })
    expect(aiEditStart(at(4, 7), 'proofread')).toEqual({
      from: 4,
      text: 'two',
      choice: 'proofread',
    })
    expect(aiEditStart(at(3, 3), 'proofread')).toBeNull()
    expect(aiEditStart(at(7, 9), 'proofread')).toBeNull()
  })
})
