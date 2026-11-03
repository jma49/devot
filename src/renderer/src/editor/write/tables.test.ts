import { history, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from '../markdown'
import { parseTable, printTable } from '../table'
import { writeBlocks } from './blocks'
import { writeFocusTracking } from './focus'
import { shownWidth, writeTables } from './tableGrid'
import {
  atomicSpans,
  caretInCell,
  cellEdit,
  cellSource,
  hiddenSpans,
  structureSpans,
  writeTablesOf,
  type Span,
} from './tables'

const TABLE = ['| Name | Qty |', '| ---- | --: |', '| Tea  |   2 |', '|      |   3 |'].join('\n')

function stateOf(doc: string, caret = 0): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [
      noteMarkdown,
      writeFocusTracking,
      writeBlocks,
      writeTables,
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state
}

function parsed(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 1e9)
  return state
}

const step = (state: EditorState, spec: TransactionSpec) => parsed(state.update(spec).state)

/** Types `text` at the caret as the keyboard does. */
function type(state: EditorState, text: string): EditorState {
  const { from, to } = state.selection.main
  return step(state, {
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: 'input.type',
  })
}

const slices = (doc: string, spans: Span[]) => spans.map(([a, b]) => doc.slice(a, b))
const formatted = (doc: string) => printTable(parseTable(doc.split('\n'))!).lines.join('\n')
/** The caret's place, marked `^` in the text. */
const marked = (state: EditorState) => {
  const doc = state.doc.toString()
  const at = state.selection.main.head
  return doc.slice(0, at) + '^' + doc.slice(at)
}

describe('the cells of a table in Write mode', () => {
  it('map each cell to its text between the pipes', () => {
    const [table] = writeTablesOf(stateOf(TABLE))
    expect(table!.align).toEqual(['none', 'right'])
    const texts = table!.lines.map((line) =>
      line.cells.map((c) => [TABLE.slice(c.from, c.to), TABLE.slice(c.textFrom, c.textTo)]),
    )
    expect(texts).toEqual([
      [
        [' Name ', 'Name'],
        [' Qty ', 'Qty'],
      ],
      [],
      [
        [' Tea  ', 'Tea'],
        ['   2 ', '2'],
      ],
      [
        ['      ', ''],
        ['   3 ', '3'],
      ],
    ])
  })

  it('read rows without outer pipes and indented rows', () => {
    const doc = '  a | b\n  --|--\n  1 | 2'
    const [table] = writeTablesOf(stateOf(doc))
    expect(table!.lines.map((l) => l.indent)).toEqual(['  ', '  ', '  '])
    expect(table!.lines[2]!.cells.map((c) => doc.slice(c.textFrom, c.textTo))).toEqual(['1', '2'])
  })

  it('leave as source a table in a list, one with a cell with nothing between its pipes and a row of too many cells', () => {
    expect(writeTablesOf(stateOf('- | a |\n  | - |\n  | 1 |'))).toHaveLength(0)
    expect(writeTablesOf(stateOf('| a | b |\n| - | - |\n| 1 || '))).toHaveLength(0)
    expect(writeTablesOf(stateOf('| a |\n| - |\n| 1 | 2 |'))).toHaveLength(0)
  })

  it('hide the pipes, the padding and the delimiter row, and show an empty cell as a point', () => {
    const [table] = writeTablesOf(stateOf(TABLE))
    const hidden = slices(TABLE, hiddenSpans(table!, null))
    expect(hidden).toEqual([
      '| ',
      ' ',
      '| ',
      ' |\n| ---- | --: |',
      '| ',
      '  ',
      '|   ',
      ' |',
      '| ',
      '     ',
      '|   ',
      ' |',
    ])
  })

  it('show the spaces typed after a cell text while the caret is after them', () => {
    const doc = '| ab   | c |\n| - | - |'
    const [table] = writeTablesOf(stateOf(doc))
    expect(slices(doc, hiddenSpans(table!, 5)).slice(0, 2)).toEqual(['| ', '  '])
    expect(slices(doc, hiddenSpans(table!, null)).slice(0, 2)).toEqual(['| ', '   '])
  })

  it('step over the structure from one cell to the next, and into and out of the table', () => {
    const doc = `x\n${TABLE}\ny`
    const [table] = writeTablesOf(stateOf(doc))
    const spans = atomicSpans(table!, null, doc.length)
    expect(slices(doc, spans)).toEqual([
      '\n| ',
      ' | ',
      ' |\n| ---- | --: |\n| ',
      '  |   ',
      // The empty cell is a point between two units, where the caret stops.
      ' |\n| ',
      '     |   ',
      ' |\n',
    ])
    expect(spans[4]![1]).toBe(doc.indexOf('|      |') + 2)
  })

  it('keep the pipes and line breaks from an edit, not the cells', () => {
    const doc = `x\n| a | b |\n| - | - |\ny`
    const [table] = writeTablesOf(stateOf(doc))
    expect(slices(doc, structureSpans(table!, doc.length))).toEqual(['\n|', '|', '|\n| - | - |\n'])
  })

  it('move a caret on the structure into the nearest cell', () => {
    const [table] = writeTablesOf(stateOf(TABLE))
    const at = (pos: number) => {
      const to = caretInCell(table!, pos)
      return to === null ? null : TABLE.slice(0, to) + '^'
    }
    expect(at(0)).toBe('| ^')
    expect(at(TABLE.indexOf('| ---'))).toBe('| Name | Qty^')
    expect(at(TABLE.indexOf('Tea') + 1)).toBeNull()
    expect(at(TABLE.indexOf('Tea') + 5)).toBe(TABLE.slice(0, TABLE.indexOf('Tea') + 3) + '^')
    expect(at(TABLE.indexOf('|   2') + 2)).toBe(TABLE.slice(0, TABLE.indexOf('2 |')) + '^')
    expect(at(TABLE.indexOf('|   2 |') + 7)).toBe(TABLE.slice(0, TABLE.indexOf('2 |') + 1) + '^')
    const empty = TABLE.indexOf('|      |')
    expect(at(empty + 4)).toBe(TABLE.slice(0, empty + 2) + '^')
  })
})

describe('a cell edit', () => {
  it('escapes the pipes and turns line breaks to spaces', () => {
    expect(cellSource('a|b')).toBe('a\\|b')
    expect(cellSource('a\\|b')).toBe('a\\|b')
    expect(cellSource('a\\\\|b')).toBe('a\\\\\\|b')
    expect(cellSource('one\r\ntwo\nthree')).toBe('one two three')
  })

  it('keeps the spaces typed before the caret, and trims the others', () => {
    expect(cellEdit('  ab   ', null)).toEqual({ text: 'ab', offset: 0 })
    expect(cellEdit('  ab   ', 5)).toEqual({ text: 'ab ', offset: 3 })
    expect(cellEdit('  ab   ', 3)).toEqual({ text: 'ab', offset: 1 })
    expect(cellEdit('  ab   ', 1)).toEqual({ text: 'ab', offset: 0 })
    expect(cellEdit(' a|', 3)).toEqual({ text: 'a\\|', offset: 3 })
    expect(cellEdit('     ', 3)).toEqual({ text: '', offset: 0 })
  })

  it('counts the shown text for a column width, not its marks', () => {
    expect(shownWidth('**bold** [link](https://example.com/a/long/path)')).toBe(9)
    expect(shownWidth('a \\| b')).toBe(5)
  })
})

describe('typing in a shown table', () => {
  const doc = formatted(TABLE)
  const inTea = doc.indexOf('Tea') + 3

  it('prints the table again as the formatter does, with the caret after the typed text', () => {
    const state = type(stateOf(doc, inTea), 'pot leaves')
    const text = state.doc.toString()
    expect(text).toBe(formatted(text))
    expect(text.split('\n')[2]).toBe('| Teapot leaves |   2 |')
    expect(marked(state).split('\n')[2]).toBe('| Teapot leaves^ |   2 |')
  })

  it('types a space between words', () => {
    let state = stateOf(doc, inTea)
    for (const ch of ' cup') state = type(state, ch)
    expect(state.doc.toString().split('\n')[2]).toBe('| Tea cup |   2 |')
    expect(marked(state).split('\n')[2]).toBe('| Tea cup^ |   2 |')
  })

  it('writes a typed pipe and a pasted line break as cell text', () => {
    let state = type(stateOf(doc, inTea), '|')
    expect(state.doc.toString().split('\n')[2]).toBe('| Tea\\| |   2 |')
    state = step(stateOf(doc, inTea), {
      changes: { from: inTea, insert: 'a\nb' },
      selection: { anchor: inTea + 3 },
      userEvent: 'input.paste',
    })
    expect(marked(state).split('\n')[2]).toBe('| Teaa b^ |   2 |')
  })

  it('types into an empty cell', () => {
    const empty = doc.indexOf('|      |') + 2
    const state = type(stateOf(doc, empty), 'Milk')
    expect(marked(state).split('\n')[3]).toBe('| Milk^ |   3 |')
  })

  it("keeps the pipes when Backspace deletes over a cell's start", () => {
    const start = doc.indexOf('Tea')
    const state = step(stateOf(doc, start), {
      changes: { from: start - 2, to: start },
      selection: { anchor: start - 2 },
      userEvent: 'delete.backward',
    })
    expect(state.doc.toString()).toBe(doc)
  })

  it('deletes the text of every cell a selection meets, and the whole table when it is selected', () => {
    const from = doc.indexOf('ea')
    const to = doc.indexOf('3')
    const state = step(stateOf(doc), {
      changes: { from, to },
      selection: { anchor: from },
      userEvent: 'delete.selection',
    })
    const text = state.doc.toString()
    expect(text).toBe(formatted(text))
    expect(text.split('\n').slice(2)).toEqual(['| T    |     |', '|      |   3 |'])
    const all = step(stateOf(`${doc}\n\nafter`), {
      changes: { from: 0, to: doc.length + 2 },
      userEvent: 'delete.selection',
    })
    expect(all.doc.toString()).toBe('after')
  })

  it('undoes a typed word and the printing as one step', () => {
    let state = stateOf(doc, inTea)
    for (const ch of 'pot') state = type(state, ch)
    expect(state.doc.toString()).not.toBe(doc)
    let undone = state
    undo({ state, dispatch: (tr) => (undone = tr.state) })
    expect(undone.doc.toString()).toBe(doc)
  })

  it('leaves a table with several cursors in it as source', () => {
    const second = doc.indexOf('3') + 1
    const cursors = EditorSelection.create([
      EditorSelection.cursor(inTea),
      EditorSelection.cursor(second),
    ])
    const state = step(step(stateOf(doc), { selection: cursors }), {
      changes: [
        { from: inTea, insert: 'xxxx' },
        { from: second, insert: 'y' },
      ],
      selection: EditorSelection.create([
        EditorSelection.cursor(inTea + 4),
        EditorSelection.cursor(second + 5),
      ]),
      userEvent: 'input.type',
    })
    expect(state.doc.toString().split('\n')[2]).toBe('| Teaxxxx  |   2 |')
  })

  it('prints nothing again inside a composition', () => {
    const state = step(stateOf(doc, inTea), {
      changes: { from: inTea, insert: 'pot leaves' },
      selection: { anchor: inTea + 10 },
      userEvent: 'input.type.compose',
    })
    expect(state.doc.toString().split('\n')[2]).toBe('| Teapot leaves  |   2 |')
  })

  it('moves the caret into the last cell for a Backspace on the line under the table', () => {
    const text = `${doc}\n\nafter`
    const state = step(stateOf(text, doc.length + 1), {
      changes: { from: doc.length, to: doc.length + 1 },
      selection: { anchor: doc.length },
      userEvent: 'delete.backward',
    })
    expect(state.doc.toString()).toBe(text)
    expect(marked(state).split('\n')[3]).toBe('|      |   3^ |')
  })

  it('reprints the table after a format in a cell', () => {
    const state = step(stateOf(doc, inTea), {
      changes: [
        { from: inTea - 3, insert: '**' },
        { from: inTea, insert: '**' },
      ],
      selection: { anchor: inTea + 2 },
      userEvent: 'input.format',
    })
    expect(state.doc.toString().split('\n')[2]).toBe('| **Tea** |   2 |')
  })

  it('moves a caret put before the first pipe into the first cell', () => {
    const state = step(stateOf(doc, inTea), { selection: { anchor: 0 }, userEvent: 'select' })
    expect(state.selection.main.head).toBe(2)
  })
})

describe('the grid', () => {
  /** The source and class of each cell box, by where it starts. */
  const boxes = (state: EditorState) => {
    const out: [number, string][] = []
    for (const source of state.facet(EditorView.outerDecorations)) {
      if (typeof source === 'function') continue
      ;(source as DecorationSet).between(0, state.doc.length, (from, to, deco) => {
        out.push([from, `${state.doc.sliceString(from, to)}=${deco.spec.class as string}`])
      })
    }
    return out.sort((a, b) => a[0] - b[0]).map(([, box]) => box)
  }

  it('boxes every cell from its pipe, with its column alignment', () => {
    const doc = '| a | b |\n| - | -: |\n| 1 | 2 |'
    expect(boxes(stateOf(doc))).toEqual([
      '| a =cm-wm-cell cm-wm-align-none cm-wm-cell-first',
      '| b |\n| - | -: |=cm-wm-cell cm-wm-align-right',
      '| 1 =cm-wm-cell cm-wm-align-none cm-wm-cell-first',
      '| 2 |=cm-wm-cell cm-wm-align-right',
    ])
  })

  it('draws no box for a table several cursors are in', () => {
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |'
    const cursors = EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(6)])
    expect(boxes(step(stateOf(doc), { selection: cursors }))).toEqual([])
  })
})
