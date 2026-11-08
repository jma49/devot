import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, it } from 'vitest'
import { expectWithinBudget } from '../../../../../tests/support/budget'
import { noteMarkdown } from '../markdown'
import { setWriteFocus, writeFocusTracking } from './focus'
import { writeMode } from './index'

// Write mode draws the note's blocks again on every caret move, its tables among them.
describe('Write mode in a long note with many tables', () => {
  it('moves the caret within a frame', (context) => {
    const block =
      '## Week\n\nA paragraph of prose, as notes mostly have, with **bold** and a [link](https://example.com).\n\n| Day | Done | Notes |\n| --- | :--: | ----- |\n| Mon | yes | `ok` |\n| Tue | no | late |\n\n'
    let doc = ''
    while (doc.length < 200_000) doc += block
    let state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.indexOf('A paragraph', doc.length / 2)),
      extensions: [noteMarkdown, writeFocusTracking, writeMode()],
    })
    ensureSyntaxTree(state, doc.length, 1e9)
    state = state.update({ effects: setWriteFocus.of(true) }).state
    const times: number[] = []
    for (let i = 0; i < 21; i++) {
      const selection = EditorSelection.cursor(state.selection.main.head + 1)
      const started = performance.now()
      state = state.update({ selection, userEvent: 'select' }).state
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[10]!, 12)
  })
})

/** A 30-column, 800-row table of words, the caret at the end of a cell narrower than its column. */
function wideTable(): EditorState {
  const row = (r: number) =>
    `| ${Array.from({ length: 30 }, (_, c) => `Forecast ${r} ${c}`).join(' | ')} |`
  const lines = [row(0), `| ${Array.from({ length: 30 }, () => '---').join(' | ')} |`]
  for (let r = 1; r <= 800; r++) lines.push(row(r))
  const doc = `Above\n\n${lines.join('\n')}\n\nBelow\n`
  const cell = `Forecast 5 15`
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.indexOf(cell) + cell.length),
    extensions: [noteMarkdown, writeFocusTracking, writeMode()],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  state = state.update({ effects: setWriteFocus.of(true) }).state
  return state
}

function medianStep(step: (state: EditorState) => EditorState): number {
  let state = wideTable()
  const times: number[] = []
  for (let i = 0; i < 31; i++) {
    const started = performance.now()
    state = step(state)
    if (i >= 10) times.push(performance.now() - started)
    ensureSyntaxTree(state, state.doc.length, 1e9)
  }
  times.sort((a, b) => a - b)
  return times[times.length >> 1]!
}

// Before issue 722 a keystroke here took about 120 ms (the table is printed again and drawn whole) and a
// caret move 45 ms; its column minimums and sideways scroll must not add to either.
describe('Write mode in a 30-column, 800-row table', () => {
  it('types a character in a cell', (context) => {
    let deleting = false
    const typed = medianStep((state) => {
      deleting = !deleting
      const at = state.selection.main.head
      return state.update(
        deleting
          ? {
              changes: { from: at - 1, to: at },
              selection: EditorSelection.cursor(at - 1),
              userEvent: 'delete.backward',
            }
          : {
              changes: { from: at, insert: 'x' },
              selection: EditorSelection.cursor(at + 1),
              userEvent: 'input.type',
            },
      ).state
    })
    expectWithinBudget(context, typed, 180)
  }, 60_000)

  it('moves the caret in a cell', (context) => {
    let back = false
    const moved = medianStep((state) => {
      back = !back
      const head = state.selection.main.head + (back ? -1 : 1)
      return state.update({
        selection: EditorSelection.cursor(head),
        userEvent: 'select',
      }).state
    })
    expectWithinBudget(context, moved, 60)
  }, 60_000)
})
