import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, it } from 'vitest'
import { expectWithinBudget } from '../../../../../tests/support/budget'
import { noteMarkdown } from '../markdown'
import { setWriteFocus, writeFocusTracking } from './focus'
import { writeMode } from './index'

const FRAME_MS = 8

// No code in a language the editor highlights: parsing it is the editor's
// cost, with Write mode or without.
const SECTION = [
  '## Week',
  '',
  'A paragraph of prose, as notes mostly have, with **bold**, a [link](https://example.com) and a note[^n].',
  '',
  '| Day | Done | Notes |',
  '| --- | :--: | ----- |',
  '| Mon | yes | `ok` |',
  '| Tue | no | late |',
  '',
  '$$',
  'e^{i\\pi} + 1 = 0',
  '$$',
  '',
  '![chart](https://example.com/chart.png)',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '- a task list',
  '- [ ] with a task',
  '',
].join('\n')

/** About 200 KB of every kind of block Write mode draws, the caret in a paragraph halfway down. */
function mixedNote(): EditorState {
  let doc = ''
  while (doc.length < 200_000) doc += SECTION
  doc += '\n[^n]: The footnote.\n'
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.indexOf('and a note', doc.length / 2)),
    extensions: [noteMarkdown, writeFocusTracking, writeMode()],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state.update({ effects: setWriteFocus.of(true) }).state
}

/** The parser catches up after a step, as the editor's idle work does. */
function settled(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 1e9)
  return state.update({}).state
}

const typed = (state: EditorState): EditorState => {
  const at = state.selection.main.head
  return state.update({
    changes: { from: at, insert: 'x' },
    selection: EditorSelection.cursor(at + 1),
    userEvent: 'input.type',
  }).state
}

const moved = (state: EditorState): EditorState =>
  state.update({
    selection: EditorSelection.cursor(state.selection.main.head + 1),
    userEvent: 'select',
  }).state

/** The median time of a step, after a few to warm up. */
function median(step: (state: EditorState) => EditorState): number {
  let state = mixedNote()
  const times: number[] = []
  for (let i = 0; i < 31; i++) {
    const started = performance.now()
    state = step(state)
    if (i >= 10) times.push(performance.now() - started)
    state = settled(state)
  }
  times.sort((a, b) => a - b)
  return times[times.length >> 1]!
}

describe('Write mode in a long mixed note', () => {
  it('types a character within a frame', (context) => {
    expectWithinBudget(context, median(typed), FRAME_MS)
  })

  it('moves the caret within a frame', (context) => {
    expectWithinBudget(context, median(moved), FRAME_MS)
  })
})
