import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { barsMayShow } from './barRules'
import { copyBlock } from './codeBlocks'
import { noteMarkdown } from './markdown'
import { setToolbarFocus, toolbarStateExtension, toolbarVisible } from './toolbarState'

function state(doc: string, selection: { anchor: number; head?: number }) {
  const s = EditorState.create({
    doc,
    selection,
    extensions: [noteMarkdown, toolbarStateExtension],
  })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s
}
const focused = (s: EditorState, on: boolean) => s.update({ effects: setToolbarFocus.of(on) }).state

describe('the floating bars', () => {
  const code = '```js\nlet a = 1\n```'

  it('show only while the editor has focus', () => {
    const s = state(code, EditorSelection.cursor(8))
    expect(barsMayShow(s)).toBe(false)
    expect(barsMayShow(focused(s, true))).toBe(true)
    expect(barsMayShow(focused(focused(s, true), false))).toBe(false)
  })

  it('give a code block its copy button only while the editor has focus', () => {
    const s = state(code, EditorSelection.cursor(8))
    expect(copyBlock(s)).toBeNull()
    expect(copyBlock(focused(s, true))?.from).toBe(0)
    expect(
      copyBlock(focused(state(code + '\n\nafter', EditorSelection.cursor(code.length + 3)), true)),
    ).toBeNull()
  })

  it('show the selection toolbar on the same rule', () => {
    const s = state('some words', EditorSelection.range(0, 4))
    expect(toolbarVisible(s)).toBe(false)
    expect(toolbarVisible(focused(s, true))).toBe(true)
  })
})
