import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../../tests/support/budget'
import { noteMarkdown } from '../markdown'
import { writeBlocksOf } from './blockRanges'

// Write mode reads a note's rendered blocks again after every keystroke.
describe('Write mode blocks of a note with many formulas', () => {
  it('finds each formula without reading the note again from its start', (context) => {
    const formulas = 3000
    const doc = Array.from({ length: formulas }, (_, i) => `Step ${i}\n\n$$\nx_${i}\n$$\n`).join(
      '\n',
    )
    let state = EditorState.create({ doc, extensions: [noteMarkdown] })
    ensureSyntaxTree(state, doc.length, 1e9)
    state = state.update({}).state
    expect(writeBlocksOf(state).filter((b) => b.kind === 'math')).toHaveLength(formulas)
    const times: number[] = []
    for (let i = 0; i < 9; i++) {
      state = state.update({ changes: { from: 0, insert: 'a' } }).state
      const started = performance.now()
      writeBlocksOf(state)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[4]!, 15)
  })
})
