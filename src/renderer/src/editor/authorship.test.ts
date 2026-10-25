import { EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import * as Y from 'yjs'
import { applyAgentEdit, newWriter, readWrites } from '../../../core/authorship'
import { fullDate } from '../format'
import { authoredField, markLabel, markSegments, segmentRange, type WriteInfo } from './authorship'

const doc = Text.of(['one', 'two', 'three', 'four', 'five'])
const lineOf = (pos: number) => doc.lineAt(pos).number
const at = (line: number, offset = 0) => doc.line(line).from + offset

describe('markSegments', () => {
  it('marks every line a run touches, and not the line a run ends before', () => {
    const runs = [{ from: at(2, 1), to: at(4), writeId: 'a' }]
    expect(markSegments(runs, lineOf)).toEqual([{ fromLine: 2, toLine: 3, writeIds: ['a'] }])
  })

  it('splits where the writes on a line change, and joins lines with the same writes', () => {
    const runs = [
      { from: at(1), to: at(1, 3), writeId: 'a' },
      { from: at(2), to: at(2, 2), writeId: 'a' },
      { from: at(2, 2), to: at(3, 2), writeId: 'b' },
      { from: at(5), to: at(5, 1), writeId: 'b' },
    ]
    expect(markSegments(runs, lineOf)).toEqual([
      { fromLine: 1, toLine: 1, writeIds: ['a'] },
      { fromLine: 2, toLine: 2, writeIds: ['a', 'b'] },
      { fromLine: 3, toLine: 3, writeIds: ['b'] },
      { fromLine: 5, toLine: 5, writeIds: ['b'] },
    ])
  })

  it('keeps a typed key quick in a note with thousands of agent runs', (context) => {
    const lines = 5_000
    const long = Text.of(Array.from({ length: lines }, (_, i) => `line ${i}`))
    const runs = Array.from({ length: lines }, (_, i) => {
      const line = long.line(i + 1)
      return { from: line.from, to: line.to, writeId: `w${i % 7}` }
    })
    const started = performance.now()
    const segments = markSegments(runs, (pos) => long.lineAt(pos).number)
    expectWithinBudget(context, performance.now() - started, 16)
    expect(segments).toHaveLength(lines)
  })

  it('names the writes of a segment in the order their runs start, each once', () => {
    const runs = [
      { from: at(2), to: at(3, 2), writeId: 'b' },
      { from: at(1), to: at(3, 2), writeId: 'a' },
      { from: at(3), to: at(3, 1), writeId: 'b' },
      { from: at(3), to: at(3, 1), writeId: 'c' },
    ]
    expect(markSegments(runs, lineOf)).toEqual([
      { fromLine: 1, toLine: 1, writeIds: ['a'] },
      { fromLine: 2, toLine: 2, writeIds: ['a', 'b'] },
      { fromLine: 3, toLine: 3, writeIds: ['a', 'b', 'c'] },
    ])
  })

  it('makes one segment of a run over many lines, whatever the note’s length', () => {
    const long = Text.of(Array.from({ length: 20_000 }, (_, i) => `line ${i}`))
    const runs = [{ from: 0, to: long.length, writeId: 'a' }]
    expect(markSegments(runs, (pos) => long.lineAt(pos).number)).toEqual([
      { fromLine: 1, toLine: 20_000, writeIds: ['a'] },
    ])
  })
})

describe('a mark', () => {
  it('selects the agents’ text on its lines', () => {
    const runs = [
      { from: at(2, 1), to: at(2, 3), writeId: 'a' },
      { from: at(3), to: at(3, 4), writeId: 'a' },
    ]
    const [segment] = markSegments(runs, lineOf)
    expect(segmentRange(segment!, runs, doc)).toEqual({ from: at(2, 1), to: at(3, 4) })
  })

  it('is named by its writers, with their kinds, and the newest write’s time', () => {
    const claude: WriteInfo = { writer: newWriter('mcp', 'Claude Code', 'p'), at: 1_000 }
    const http: WriteInfo = { writer: newWriter('http', '', 'p'), at: 2_000 }
    const writes = new Map([
      ['a', claude],
      ['b', http],
    ])
    const label = markLabel({ fromLine: 1, toLine: 1, writeIds: ['a', 'b'] }, writes, 'en')
    expect(label).toBe(`Written by Claude Code (MCP) and HTTP API, ${fullDate(2_000, 'en')}`)
  })
})

describe('the marks’ state', () => {
  it('reads the runs from the replica and maps them through the editor’s edits', () => {
    const ydoc = new Y.Doc()
    ydoc.getText('body').insert(0, 'Intro.\n')
    applyAgentEdit(ydoc, {
      writer: newWriter('mcp', 'Claude Code', 'p'),
      at: 1,
      markdown: 'Intro.\nAgent line.\n',
    })
    const field = authoredField(ydoc, 'note')
    const state = EditorState.create({ doc: ydoc.getText('body').toString(), extensions: field })
    const [write] = readWrites(ydoc)
    expect(state.field(field).segments).toEqual([{ fromLine: 2, toLine: 2, writeIds: [write!.id] }])
    const typed = state.update({ changes: { from: 0, insert: 'Owner.\n' } }).state
    expect(typed.field(field).segments).toEqual([{ fromLine: 3, toLine: 3, writeIds: [write!.id] }])
  })

  it('reads nothing from a note without records', () => {
    const ydoc = new Y.Doc()
    ydoc.getText('body').insert(0, 'Text.\n')
    const field = authoredField(ydoc, 'note')
    const state = EditorState.create({ doc: 'Text.\n', extensions: field })
    expect(state.field(field).runs).toEqual([])
  })
})
