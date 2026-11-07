// @vitest-environment happy-dom
import { history, redo, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, type Decoration, type DecorationSet } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteMarkdown } from '../markdown'
import { drawnBlocks, viewBlocks } from './blocks'
import { setWriteFocus, writeFocusTracking } from './focus'
import { writeMode } from './index'

const TABLE = '| Day | Done |\n| --- | --- |\n| Mon | yes |'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

function stateOf(doc: string, caret = 0): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [noteMarkdown, writeFocusTracking, writeMode(), history()],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state
}

function open(doc: string, caret = 0): EditorView {
  view = new EditorView({ state: stateOf(doc, caret), parent: document.body })
  view.dispatch({ effects: setWriteFocus.of(true) })
  return view
}

const ids = new Map<Decoration, number>()
function listed(set: DecorationSet, from: number, to: number): string[] {
  const out: string[] = []
  set.between(from, to, (a, b, value) => {
    if (!ids.has(value)) ids.set(value, ids.size)
    out.push(`${a}-${b} #${ids.get(value)}`)
  })
  return out
}

/** What the plugin gives the editor, against what the field draws over the viewport. */
function givenAndDrawn(editor: EditorView) {
  const { from, to } = editor.viewport
  const given = viewBlocks(editor)
  const drawn = drawnBlocks(editor.state)
  return {
    given: {
      inline: listed(given.inline, from, to),
      outer: listed(given.outer, from, to),
    },
    drawn: {
      inline: listed(drawn.decorations[1]!, from, to),
      outer: listed(drawn.outer, from, to),
    },
  }
}

function expectGivenAsDrawn(editor: EditorView) {
  const { given, drawn } = givenAndDrawn(editor)
  expect(given).toEqual(drawn)
}

/** A hidden piece of the table that holds more than one character, so text can go inside it. */
function hiddenInTable(editor: EditorView, table: number): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  drawnBlocks(editor.state).decorations[1]!.between(table, editor.state.doc.length, (a, b, v) => {
    if (!found && v.point && b - a >= 2) found = { from: a, to: b }
  })
  if (!found) throw new Error('no hidden piece')
  return found
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

  it('follow the caret into a table and out, through an edit, its undo and redo', () => {
    const doc = `Above\n\n${TABLE}\n\nBelow`
    const editor = open(doc)
    const rows = () => editor.contentDOM.querySelectorAll('.cm-line.cm-wm-row').length
    const cells = () => editor.contentDOM.querySelectorAll('.cm-wm-cell').length
    const shown = { rows: rows(), cells: cells() }
    expectGivenAsDrawn(editor)
    const listedBefore = givenAndDrawn(editor).given.inline
    editor.dispatch({ selection: { anchor: doc.indexOf('Mon') + 1 }, userEvent: 'select' })
    expectGivenAsDrawn(editor)
    const at = doc.indexOf('Mon') + 3
    editor.dispatch({
      changes: { from: at, insert: 'day' },
      selection: { anchor: at + 3 },
      userEvent: 'input.type',
    })
    expectGivenAsDrawn(editor)
    expect(givenAndDrawn(editor).given.inline).not.toEqual(listedBefore)
    undo(editor)
    expect(editor.state.doc.toString()).toBe(doc)
    expectGivenAsDrawn(editor)
    redo(editor)
    expectGivenAsDrawn(editor)
    undo(editor)
    editor.dispatch({ selection: { anchor: doc.length }, userEvent: 'select' })
    expectGivenAsDrawn(editor)
    expect(givenAndDrawn(editor).given.inline).toEqual(listedBefore)
    expect({ rows: rows(), cells: cells() }).toEqual(shown)
  })

  it('draw a note given to the editor in place of another', () => {
    const editor = open(`Above\n\n${TABLE}\n`)
    editor.setState(stateOf(`${TABLE}\n\n${TABLE}\n`, 0))
    expectGivenAsDrawn(editor)
    expect(editor.contentDOM.querySelectorAll('.cm-line.cm-wm-row').length).toBe(4)
  })

  it('move with the text while an input method composes, and draw again after it', () => {
    const doc = `Above\n\n${TABLE}\n`
    const editor = open(doc, 2)
    editor.contentDOM.dispatchEvent(new Event('compositionstart'))
    expect(editor.compositionStarted).toBe(true)
    editor.dispatch({
      changes: { from: 2, insert: 'xy' },
      selection: { anchor: 4 },
      userEvent: 'input.type.compose',
    })
    expectGivenAsDrawn(editor)
    editor.contentDOM.dispatchEvent(new Event('compositionend'))
    editor.dispatch({ selection: { anchor: 4 }, userEvent: 'select' })
    expectGivenAsDrawn(editor)
    expect(editor.contentDOM.querySelectorAll('.cm-line.cm-wm-row').length).toBe(2)
  })

  it.each([
    ['inside a composition', true],
    ['while the blocks are only mapped', false],
  ])(
    'keep a line break that lands in a hidden piece of a table out of the view (%s)',
    (_, composing) => {
      const doc = `Above\n\n${TABLE}\n`
      const editor = open(doc)
      const hidden = hiddenInTable(editor, doc.indexOf('|'))
      if (composing) editor.contentDOM.dispatchEvent(new Event('compositionstart'))
      expect(() =>
        editor.dispatch({
          changes: { from: hidden.from + 1, insert: '\n' },
          userEvent: 'input.type.compose',
        }),
      ).not.toThrow()
      const crossing: string[] = []
      viewBlocks(editor).inline.between(0, editor.state.doc.length, (a, b, value) => {
        if (value.point && b > editor.state.doc.lineAt(a).to) crossing.push(`${a}-${b}`)
      })
      expect(crossing).toEqual([])
      if (composing) editor.contentDOM.dispatchEvent(new Event('compositionend'))
      editor.dispatch({ selection: { anchor: 0 }, userEvent: 'select' })
      expectGivenAsDrawn(editor)
    },
  )
})
