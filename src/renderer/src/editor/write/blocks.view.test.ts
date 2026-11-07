// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteMarkdown } from '../markdown'
import { setWriteFocus, writeFocusTracking } from './focus'
import { writeMode } from './index'

const TABLE = '| Day | Done |\n| --- | --- |\n| Mon | yes |'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

function open(doc: string, caret = 0): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [noteMarkdown, writeFocusTracking, writeMode()],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  view = new EditorView({ state, parent: document.body })
  view.dispatch({ effects: setWriteFocus.of(true) })
  return view
}

describe('the blocks in the editor', () => {
  it('draw a table in view as its grid, and again after a keystroke in a cell', () => {
    const doc = `Above\n\n${TABLE}\n`
    const editor = open(doc)
    const rows = () => editor.contentDOM.querySelectorAll('.cm-line.cm-wm-row').length
    const cells = () => editor.contentDOM.querySelectorAll('.cm-wm-cell').length
    expect(rows()).toBe(2)
    expect(cells()).toBe(4)
    const at = doc.indexOf('yes') + 3
    editor.dispatch({
      changes: { from: at, insert: '!' },
      selection: { anchor: at + 1 },
      userEvent: 'input.type',
    })
    expect(rows()).toBe(2)
    expect(cells()).toBe(4)
    expect(editor.viewport).toEqual({ from: 0, to: editor.state.doc.length })
  })

  it("give the editor a long note's tables only where it shows the note", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Line ${i} of the note.`).join('\n')
    const doc = `${TABLE}\n\n${lines}\n\n${TABLE}\n`
    const editor = open(doc)
    // What takes or joins lines comes from state for the whole note; the rest is drawn for the view.
    const drawnAt = () => {
      const out: number[] = []
      for (const facet of [EditorView.decorations, EditorView.outerDecorations])
        for (const source of editor.state.facet(facet)) {
          if (typeof source !== 'function') continue
          ;(source(editor) as DecorationSet).between(0, doc.length, (from) => {
            out.push(from)
          })
        }
      return out
    }
    const { to } = editor.viewport
    expect(to).toBeLessThan(doc.lastIndexOf(TABLE))
    expect(drawnAt().length).toBeGreaterThan(0)
    expect(drawnAt().filter((from) => from > to)).toEqual([])
    editor.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true })
    await vi.waitFor(() => expect(editor.viewport.to).toBe(doc.length))
    expect(editor.contentDOM.querySelectorAll('.cm-line.cm-wm-row').length).toBe(2)
  })
})
