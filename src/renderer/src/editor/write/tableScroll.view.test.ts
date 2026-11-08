// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { noteMarkdown } from '../markdown'
import { setWriteFocus, writeFocusTracking } from './focus'
import { writeMode } from './index'

const TABLE = '| Day | Done |\n| --- | --- |\n| Mon | yes |\n| Tue | no |'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

function open(doc: string, caret: number): EditorView {
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

const rowsOf = (editor: EditorView) => [
  ...editor.contentDOM.querySelectorAll<HTMLElement>('.cm-wm-row'),
]

function scrollRow(row: HTMLElement, x: number) {
  row.scrollLeft = x
  row.dispatchEvent(new Event('scroll'))
}

describe('a table scrolled sideways', () => {
  it('keeps its scroll for rows drawn after a line break goes in at its start', () => {
    const doc = `Above\n\n${TABLE}\n`
    const start = doc.indexOf('|')
    const editor = open(doc, 0)
    const rows = rowsOf(editor)
    expect(rows.length).toBeGreaterThan(1)
    scrollRow(rows[0]!, 120)
    expect(rows.map((r) => r.scrollLeft)).toEqual(rows.map(() => 120))

    editor.dispatch({ changes: { from: start, insert: '\n' } })
    const drawnLater = rowsOf(editor).at(-1)!
    drawnLater.scrollLeft = 0
    editor.dispatch({ changes: { from: 0, insert: 'x' } })

    expect(rowsOf(editor).map((r) => r.scrollLeft)).toEqual(rowsOf(editor).map(() => 120))
  })
})
