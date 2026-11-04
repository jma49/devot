import { history, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Range, type TransactionSpec } from '@codemirror/state'
import { EditorView, type Decoration, type DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from '../markdown'
import { parseTable, printTable } from '../table'
import { writeBlocks, type BlockLayers } from './blocks'
import { writeFocusTracking } from './focus'
import { SheetAdoption, bandsClip, layerY, shownWidth, tableRule, writeTables } from './tableGrid'
import {
  atomicSpans,
  caretInCell,
  cellEdit,
  cellTints,
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
    expect(table!.lines.map((l) => l.prefix)).toEqual(['  ', '  ', '  '])
    expect(table!.lines[2]!.cells.map((c) => doc.slice(c.textFrom, c.textTo))).toEqual(['1', '2'])
  })

  it('read a table in a quote or a list with what comes before its rows', () => {
    const quoted = writeTablesOf(stateOf('> | a | b |\n> | - | - |\n> | 1 | 2 |'))
    expect(quoted[0]!.lines.map((l) => l.prefix)).toEqual(['> ', '> ', '> '])
    const listed = writeTablesOf(stateOf('- item\n\n  | a |\n  | - |\n  | 1 |'))
    expect(listed[0]!.lines.map((l) => l.prefix)).toEqual(['  ', '  ', '  '])
  })

  it('read a cell with nothing between its pipes as empty, and leave out the cells past the columns', () => {
    const doc = '| a | b |\n| - | - |\n| 1 || 3 | 4 |\n| 5 |'
    const [table] = writeTablesOf(stateOf(doc))
    const row = table!.lines[2]!
    expect(row.cells.map((c) => [c.to - c.from, doc.slice(c.textFrom, c.textTo)])).toEqual([
      [3, '1'],
      [0, ''],
    ])
    expect(row.extra).toBe(true)
    expect(table!.lines[3]!.cells).toHaveLength(1)
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

  it('writes a pipe a composition typed escaped, with the first edit after it', () => {
    let state = stateOf(doc, inTea)
    for (const typed of ['|', 'x']) {
      const at = state.selection.main.head
      state = step(state, {
        changes: { from: at, insert: typed },
        selection: { anchor: at + 1 },
        userEvent: typed === '|' ? 'input.type.compose' : 'input.type',
      })
    }
    expect(marked(state).split('\n')[2]).toBe('| Tea\\|x^ |   2 |')
  })

  it('does not print a row with cells past the columns again', () => {
    const extra = `${doc}\n| a | b | c |`
    const at = extra.lastIndexOf('a') + 1
    const state = type(stateOf(extra, at), 'z')
    expect(state.doc.toString().split('\n').slice(-1)).toEqual(['| az | b | c |'])
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
      '| a =cm-wm-cell cm-wm-align-none cm-wm-cell-first cm-wm-cell-caret',
      '| b |\n| - | -: |=cm-wm-cell cm-wm-align-right',
      '| 1 =cm-wm-cell cm-wm-align-none cm-wm-cell-first',
      '| 2 |=cm-wm-cell cm-wm-align-right',
    ])
  })

  it('draws the cells a short row leaves out, to be written on a click', () => {
    const state = stateOf('| a | b | c |\n| - | - | - |\n| 1 |')
    const missing: string[] = []
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === 'function') continue
      ;(source as DecorationSet).between(0, state.doc.length, (from, _to, deco) => {
        const widget = deco.spec.widget as { column?: number } | undefined
        if (widget?.column !== undefined) missing.push(`${from}:${widget.column}`)
      })
    }
    expect(missing).toEqual([`${state.doc.length}:1`, `${state.doc.length}:2`])
  })

  const tinted = (state: EditorState) =>
    boxes(state)
      .filter((box) => /cm-wm-cell-(caret|selected)/.test(box))
      .map((box) => box.replace(/=.*cm-wm-cell-(caret|selected).*$/s, '=$1'))

  it("tints the caret's cell, not its row, and only while the selection is a caret", () => {
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |'
    expect(tinted(stateOf(doc, doc.indexOf('b') + 1))).toEqual(['| b |\n| - | - |=caret'])
    expect(tinted(stateOf(doc, doc.indexOf('1')))).toEqual(['| 1 =caret'])
    const word = step(stateOf(doc), {
      selection: { anchor: doc.indexOf('1'), head: doc.indexOf('1') + 1 },
    })
    expect(tinted(word)).toEqual([])
  })

  it('tints every cell a selection crosses whole, and none outside it', () => {
    const doc = 'Above\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nBelow'
    const fromA = step(stateOf(doc), {
      selection: { anchor: doc.indexOf('a'), head: doc.indexOf('1') + 1 },
    })
    expect(tinted(fromA)).toEqual(['| a =selected', '| b |\n| - | - |=selected', '| 1 =selected'])
    const all = step(stateOf(doc), {
      selection: { anchor: 0, head: doc.length },
    })
    expect(tinted(all)).toHaveLength(4)
    const above = step(stateOf(doc), {
      selection: { anchor: 0, head: doc.indexOf('|') },
    })
    expect(tinted(above)).toEqual([])
  })

  it("selects a short row's missing cells only when the selection runs to the row's end", () => {
    const doc = '| a | b | c |\n| - | - | - |\n| Tea |\n\nBelow'
    const missingSelected = (state: EditorState) => {
      const out: boolean[] = []
      for (const source of state.facet(EditorView.decorations)) {
        if (typeof source === 'function') continue
        ;(source as DecorationSet).between(0, state.doc.length, (_from, _to, deco) => {
          const widget = deco.spec.widget as { className?: string } | undefined
          if (widget?.className?.includes('cm-wm-cell-missing'))
            out.push(widget.className.includes('cm-wm-cell-selected'))
        })
      }
      return out
    }
    const tea = doc.indexOf('Tea')
    expect(
      missingSelected(step(stateOf(doc), { selection: { anchor: 2, head: tea + 1 } })),
    ).toEqual([false, false])
    expect(
      missingSelected(step(stateOf(doc), { selection: { anchor: 2, head: doc.length } })),
    ).toEqual([true, true])
  })

  it('draws no box for a table several cursors are in', () => {
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |'
    const cursors = EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(6)])
    expect(boxes(step(stateOf(doc), { selection: cursors }))).toEqual([])
  })
})

describe('the tints of a selection in a grid', () => {
  const doc = '| Name | Qty |\n| ---- | --: |\n| Tea  |   2 |\n| Pot  |   1 |'
  const tints = (anchor: number, head = anchor) => {
    const state = step(stateOf(doc), { selection: { anchor, head } })
    return cellTints(writeTablesOf(state)[0]!, state.selection)
  }

  it("marks the caret's cell, its first box from the row's start", () => {
    expect(tints(doc.indexOf('Qty'))).toEqual([
      [null, 'caret'],
      [null, null],
      [null, null],
    ])
    expect(tints(doc.indexOf('Tea'))).toEqual([
      [null, null],
      ['caret', null],
      [null, null],
    ])
  })

  it('leaves a selection inside one cell to be drawn as text', () => {
    const tea = doc.indexOf('Tea')
    expect(
      tints(tea, tea + 2)
        .flat()
        .filter(Boolean),
    ).toEqual([])
  })

  it('takes every cell from the first the selection meets to the last, once it leaves a cell', () => {
    const tea = doc.indexOf('Tea')
    expect(tints(tea, doc.indexOf('1'))).toEqual([
      [null, null],
      ['selected', 'selected'],
      ['selected', 'selected'],
    ])
    expect(tints(doc.indexOf('Qty') + 1, tea + 1)).toEqual([
      [null, 'selected'],
      ['selected', null],
      [null, null],
    ])
  })
})

describe('the clip that keeps the selection layer off a grid', () => {
  it("measures a line block in the layer's units, under a scaled view too", () => {
    const frame = { documentTop: 150, scrollerTop: 100, scrollTop: 40, scaleY: 1 }
    expect(layerY(60, frame)).toBe(150)
    expect(layerY(60, { ...frame, documentTop: 136, scaleY: 0.9 })).toBeCloseTo(126)
  })

  it('leaves everything but the bands the grids take', () => {
    expect(bandsClip([])).toBe('')
    const clip = bandsClip([
      [100, 160],
      [300, 340.5],
    ])
    const rects = [
      ...clip.matchAll(/M -?\d+(?:\.\d+)? (-?\d+(?:\.\d+)?) H -?\d+ V (-?\d+(?:\.\d+)?)/g),
    ].map((m) => [Number(m[1]), Number(m[2])])
    expect(clip).toMatch(/^path\('.*'\)$/)
    expect(rects).toEqual([
      [-1e6, 100],
      [160, 300],
      [340.5, 1e6],
    ])
  })
})

describe('a grid drawn again', () => {
  /** Each layer's decorations, placed from `at`, with their classes. */
  const drawing = (state: EditorState, at: number) => {
    const pieces = tableRule.pieces(state, [], 0, state.doc.length)
    const all = (layer: keyof BlockLayers) => pieces.flatMap((piece) => piece.layers[layer])
    const [decorations, outer, atomic] = [all('decorations'), all('outer'), all('atomic')]
    const shown = (ranges: readonly Range<Decoration>[]) =>
      ranges.map((r) => {
        const spec = r.value.spec as { class?: string; widget?: { className?: string } }
        return `${r.from - at}-${r.to - at} ${spec.class ?? spec.widget?.className ?? ''}`
      })
    return { decorations: shown(decorations), outer: shown(outer), atomic: shown(atomic) }
  }

  it('is the same after the table moves, and changes once the caret enters it', () => {
    const doc = `Intro\n\n${TABLE}\n\nOutro`
    const at = doc.indexOf('|')
    const before = stateOf(doc, 0)
    const drawn = drawing(before, at)
    const words = 'More words '
    const moved = type(before, words)
    expect(drawing(moved, at + words.length)).toEqual(drawn)
    const tea = moved.doc.toString().indexOf('Tea') + 1
    const inside = step(moved, { selection: { anchor: tea } })
    const entered = drawing(inside, at + words.length)
    expect(entered).not.toEqual(drawn)
    expect(drawing(stateOf(inside.doc.toString(), tea), at + words.length)).toEqual(entered)
  })

  it('draws two tables of the same text alike', () => {
    const doc = `${TABLE}\n\nBetween\n\n${TABLE}\n\nEnd`
    const { outer } = drawing(stateOf(doc, doc.indexOf('Between')), 0)
    const half = outer.length / 2
    const second = drawing(stateOf(doc, doc.indexOf('Between')), doc.lastIndexOf(TABLE)).outer
    expect(second.slice(half)).toEqual(outer.slice(0, half))
  })

  it('steps out of a table at the end of the note, wherever it was drawn before', () => {
    const lastAtom = (doc: string) => drawing(stateOf(doc, 0), 0).atomic.at(-1)
    const within = `x\n\n${TABLE}\n`
    const atEnd = `x\n\n${TABLE}`
    // From after the last cell's text (` |`, and the line break after it) to the end.
    expect(lastAtom(within)).toBe(`${within.length - 3}-${within.length} `)
    expect(lastAtom(atEnd)).toBe(`${atEnd.length - 2}-${atEnd.length} `)
  })
})

describe('the column sheet in the editor root', () => {
  const growingSheet = () => {
    const rules: unknown[] = []
    return { sheet: { cssRules: rules } as unknown as CSSStyleSheet, add: () => rules.push({}) }
  }
  const other = {} as CSSStyleSheet

  it('adopts the sheet after the root sheets and leaves an unchanged root alone', () => {
    const { sheet } = growingSheet()
    const root = { adoptedStyleSheets: [other] }
    const adoption = new SheetAdoption(sheet)
    adoption.ensure(root)
    const adopted = root.adoptedStyleSheets
    expect(adopted).toEqual([other, sheet])
    adoption.ensure(root)
    expect(root.adoptedStyleSheets).toBe(adopted)
  })

  it('adopts it again once the root list is replaced without it', () => {
    const { sheet } = growingSheet()
    const root = { adoptedStyleSheets: [other] }
    const adoption = new SheetAdoption(sheet)
    adoption.ensure(root)
    root.adoptedStyleSheets = [other]
    adoption.ensure(root)
    expect(root.adoptedStyleSheets).toEqual([other, sheet])
  })

  it('adopts the list anew when the sheet gains a rule, so the root restyles', () => {
    const { sheet, add } = growingSheet()
    const root = { adoptedStyleSheets: [sheet, other] }
    const adoption = new SheetAdoption(sheet)
    adoption.ensure(root)
    const adopted = root.adoptedStyleSheets
    expect(adopted).toEqual([other, sheet])
    add()
    adoption.ensure(root)
    expect(root.adoptedStyleSheets).not.toBe(adopted)
    expect(root.adoptedStyleSheets).toEqual([other, sheet])
  })

  it('adopts it in a new root', () => {
    const { sheet } = growingSheet()
    const adoption = new SheetAdoption(sheet)
    const first = { adoptedStyleSheets: [] as CSSStyleSheet[] }
    const second = { adoptedStyleSheets: [other] }
    adoption.ensure(first)
    adoption.ensure(second)
    expect(second.adoptedStyleSheets).toEqual([other, sheet])
  })
})
