import { ensureSyntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  RangeSet,
  type RangeValue,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { describe, it } from 'vitest'
import { expectWithinBudget } from '../../../../../tests/support/budget'
import { noteMarkdown } from '../markdown'
import { setWriteFocus, writeFocusTracking } from './focus'
import { carryFootnotes, footnoteNumbers } from './footnotes'
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

/** About `size` characters of every kind of block Write mode draws, the caret in a paragraph halfway down. */
function mixedNote(size = 200_000): EditorState {
  let doc = ''
  while (doc.length < size) doc += SECTION
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

const typing = (state: EditorState): TransactionSpec => {
  const at = state.selection.main.head
  return {
    changes: { from: at, insert: 'x' },
    selection: EditorSelection.cursor(at + 1),
    userEvent: 'input.type',
  }
}

const typed = (state: EditorState): EditorState => state.update(typing(state)).state

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

/** The decorations CodeMirror reads from state, which it compares on every update. */
function stateDecorations(state: EditorState): RangeSet<RangeValue>[] {
  const sets: RangeSet<RangeValue>[] = []
  for (const facet of [EditorView.decorations, EditorView.outerDecorations])
    for (const source of state.facet(facet))
      if (typeof source !== 'function') sets.push(source as DecorationSet)
  return sets
}

const ignored = { compareRange() {}, comparePoint() {} }

describe('Write mode in a long mixed note', () => {
  // Main took 34 ms here; what is left grows with the blocks that take lines, about 2.7 ms at 2.4 MB.
  it("costs the editor's decoration diff under half a frame per keystroke in a 2 MB note", (context) => {
    let state = mixedNote(2_400_000)
    const times: number[] = []
    for (let i = 0; i < 31; i++) {
      const tr = state.update(typing(state))
      const [before, after] = [stateDecorations(state), stateDecorations(tr.state)]
      const started = performance.now()
      // As the view does: once for the lines' heights, once for what to draw again.
      RangeSet.compare(before, after, tr.changes, ignored, 0)
      RangeSet.compare(before, after, tr.changes, ignored)
      if (i >= 10) times.push(performance.now() - started)
      state = tr.state
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[times.length >> 1]!, FRAME_MS / 2)
  }, 120_000)

  it('types a character within a frame', (context) => {
    expectWithinBudget(context, median(typed), FRAME_MS)
  })

  it('moves the caret within a frame', (context) => {
    expectWithinBudget(context, median(moved), FRAME_MS)
  })

  it('numbers its footnotes again after a keystroke in a fraction of a frame', (context) => {
    let state = mixedNote()
    footnoteNumbers(state.doc)
    const times: number[] = []
    for (let i = 0; i < 31; i++) {
      const tr = state.update(typing(state))
      const started = performance.now()
      carryFootnotes(tr)
      footnoteNumbers(tr.newDoc)
      if (i >= 10) times.push(performance.now() - started)
      state = tr.state
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[times.length >> 1]!, 1)
  })
})
