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
