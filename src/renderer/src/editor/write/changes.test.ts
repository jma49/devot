import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, type ChangeSpec, type Transaction } from '@codemirror/state'
import { Tree } from '@lezer/common'
import { describe, expect, it } from 'vitest'
import { randomChange, randomNote, seeded } from '../../../../../tests/support/random-notes'
import { noteMarkdown } from '../markdown'
import { carryWriteBlocks, writeBlocksOf } from './blockRanges'
import { changedSpans, lineSpans } from './changes'
import { carryWriteTables, writeTablesOf } from './tables'

const EDITS = 250

/**
 * The same tree as a new object, so what is read from it is read again in
 * full: a step's parse may stop short of the note's end on a busy machine.
 */
function sameTree(state: EditorState): Tree {
  const tree = syntaxTree(state)
  return new Tree(tree.type, tree.children, tree.positions, tree.length)
}

function parsed(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [noteMarkdown] })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state.update({}).state
}

/** Random notes, each with a random edit. */
function* randomEdits(
  count: number,
  seed: number,
): Generator<{ state: EditorState; tr: Transaction }> {
  const next = seeded(seed)
  for (let i = 0; i < count; i++) {
    const doc = randomNote(next)
    const state = parsed(doc)
    yield { state, tr: state.update({ changes: randomChange(next, doc) }) }
  }
}

describe('the spans a step changes', () => {
  it('widens spans to whole lines and joins those that meet', () => {
    const state = parsed('one\ntwo\nthree\nfour')
    expect(
      lineSpans(state.doc, [
        [9, 9],
        [1, 2],
        [5, 6],
      ]),
    ).toEqual([[0, 13]])
    expect(
      lineSpans(state.doc, [
        [0, 0],
        [14, 15],
      ]),
    ).toEqual([
      [0, 3],
      [14, 18],
    ])
  })

  it('takes the lines of an edit and of the blocks parsed again, not the blocks after them', () => {
    const doc = 'Text\n\n$$\nx\n$$\n\nEnd'
    const tr = parsed(doc).update({ changes: { from: 1, insert: 'x' } })
    ensureSyntaxTree(tr.state, tr.state.doc.length, 1e9)
    expect(changedSpans(tr)).toEqual([[0, 5]])
  })
})

describe('the rendered blocks after a step', () => {
  function carried(doc: string, changes: ChangeSpec): string[] {
    const state = parsed(doc)
    writeBlocksOf(state)
    const tr = state.update({ changes })
    expect(carryWriteBlocks(tr, changedSpans(tr)!)).not.toBeNull()
    const after = tr.state.doc.toString()
    const blocks = writeBlocksOf(tr.state)
    expect(blocks).toEqual(writeBlocksOf(tr.state, sameTree(tr.state)))
    return blocks.map((b) => `${b.kind} ${after.slice(b.from, b.to)}`)
  }

  const IMAGE = '![a](https://example.com/a.png)'

  it('read on past the change while the fences it opened or closed pair again', () => {
    const doc = `Top\n\n$$\nx\n$$\n\n${IMAGE}\n\n$$\ny\n$$\n\nEnd`
    expect(carried(doc, { from: 4, insert: '$$\n' })).toEqual([
      'math $$\n\n$$',
      `math $$\n\n${IMAGE}\n\n$$`,
    ])
  })

  it('read on to the end once a fence that closed nothing closes', () => {
    const doc = `$$ z $$\n\n$$\nx\n\n${IMAGE}`
    expect(carried(doc, { from: 0, insert: '$$\n' })).toEqual([
      'math $$\n$$ z $$\n\n$$',
      `image ${IMAGE}`,
    ])
    expect(carried(doc, { from: doc.length, insert: '\n$$' })).toEqual([
      'math $$ z $$',
      `math $$\nx\n\n${IMAGE}\n$$`,
    ])
  })

  it('are none past a fence the change leaves open', () => {
    const doc = `${IMAGE}\n\nText\n\n${IMAGE}`
    expect(carried(doc, { from: doc.indexOf('Text'), insert: '$$\n' })).toEqual([`image ${IMAGE}`])
  })

  it('are those a reading of the whole note finds', () => {
    for (const { state, tr } of randomEdits(EDITS, 1)) {
      writeBlocksOf(state)
      const changed = changedSpans(tr)!
      expect(carryWriteBlocks(tr, changed)).not.toBeNull()
      const doc = tr.state.doc.toString()
      expect({ doc, blocks: writeBlocksOf(tr.state) }).toEqual({
        doc,
        blocks: writeBlocksOf(tr.state, sameTree(tr.state)),
      })
    }
  })
})

describe('the tables after a step', () => {
  it('are those a reading of the whole note finds', () => {
    for (const { state, tr } of randomEdits(EDITS, 2)) {
      writeTablesOf(state)
      expect(carryWriteTables(tr, changedSpans(tr)!)).not.toBeNull()
      const doc = tr.state.doc.toString()
      expect({ doc, tables: writeTablesOf(tr.state) }).toEqual({
        doc,
        tables: writeTablesOf(tr.state, sameTree(tr.state)),
      })
    }
  })
})
