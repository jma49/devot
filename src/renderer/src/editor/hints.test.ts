// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { chooseTemplate, editorHints } from './hints'

function emptyHint(offered: boolean) {
  const view = new EditorView({
    state: EditorState.create({
      extensions: [editorHints(), offered ? chooseTemplate.of(() => {}) : []],
    }),
    parent: document.body,
  })
  const hint = view.dom.querySelector<HTMLElement>('.cm-empty-hint')!
  const chip = hint.querySelector('button')!
  const shown = { text: hint.querySelector('span')!.textContent, chip: !chip.hidden }
  view.destroy()
  return shown
}

describe('the empty note hint', () => {
  it('offers a template where one can be chosen', () => {
    expect(emptyHint(true)).toEqual({ text: 'Just start typing, or', chip: true })
  })

  it('ends without the "or" where no template can be chosen', () => {
    expect(emptyHint(false)).toEqual({ text: 'Just start typing', chip: false })
  })
})
