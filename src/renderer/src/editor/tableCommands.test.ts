import { history, insertNewlineAndIndent, undo } from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import {
  EditorSelection,
  EditorState,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import { TABLE_COMMANDS, inTable, tableCommand, type TableCommandId } from './tableCommands'

// Test documents mark the cursor with `^` (tables are full of `|`), and a
// selected range with `«` and `»`.
function state(marked: string, extensions: Extension[] = [noteMarkdown]) {
  const ranges = []
  let doc = ''
  let start = -1
  for (const ch of marked) {
    if (ch === '«') start = doc.length
    else if (ch === '»') ranges.push(EditorSelection.range(start, doc.length))
    else if (ch === '^') ranges.push(EditorSelection.cursor(doc.length))
    else doc += ch
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
    extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
  })
}

function show(s: EditorState): string {
  const marks: [number, string][] = []
  for (const r of s.selection.ranges) {
    if (r.empty) marks.push([r.from, '^'])
    else marks.push([r.from, '«'], [r.to, '»'])
  }
  let text = s.doc.toString()
  for (const [pos, mark] of marks.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, pos) + mark + text.slice(pos)
  return text
}

const lines = (...l: string[]) => l.join('\n')

/** Runs a table command on a marked document; the marked result, or null. */
function run(id: TableCommandId, marked: string): string | null {
  const s = state(marked)
  const spec = TABLE_COMMANDS[id](s)
  return spec && show(s.update(spec).state)
}

const TABLE = lines('| a | b |', '|---|---|', '| 1 | 2 |')
const FORMATTED = ['| a   | b   |', '| --- | --- |', '| 1   | 2   |']

describe('moving between cells', () => {
  it('Tab goes to the end of the next cell and formats the table', () => {
    expect(run('nextCell', lines('| a^ | b |', '|---|---|', '| 1 | 2 |'))).toBe(
      lines('| a   | b^   |', FORMATTED[1]!, FORMATTED[2]!),
    )
  })

  it('Tab in the last cell of a row goes to the first cell of the next row', () => {
    expect(run('nextCell', lines('| a | b^ |', '|---|---|', '| 1 | 2 |'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| 1^   | 2   |'),
    )
    // From the delimiter row too.
    expect(run('nextCell', lines('| a | b |', '|---|-^--|', '| 1 | 2 |'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| 1^   | 2   |'),
    )
  })

  it('Tab in the last cell of the table adds a row', () => {
    expect(run('nextCell', lines('| a | b |', '|---|---|', '| 1 | 2 ^|'))).toBe(
      lines(...FORMATTED, '| ^    |     |'),
    )
    // A header-only table gets its first row.
    expect(run('nextCell', lines('| a | b^ |', '|---|---|'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| ^    |     |'),
    )
  })

  it('Shift+Tab goes back a cell, to the previous row from a first cell', () => {
    expect(run('previousCell', lines('| a | b |', '|---|---|', '| 1 | ^2 |'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| 1^   | 2   |'),
    )
    expect(run('previousCell', lines('| a | b |', '|---|---|', '| ^1 | 2 |'))).toBe(
      lines('| a   | b^   |', FORMATTED[1]!, FORMATTED[2]!),
    )
    // The first cell of the table stays put; the table is still formatted.
    expect(run('previousCell', lines('| ^a | b |', '|---|---|', '| 1 | 2 |'))).toBe(
      lines('| a^   | b   |', FORMATTED[1]!, FORMATTED[2]!),
    )
  })

  it('Return goes to the same column of the next row, adding one at the end', () => {
    expect(run('nextRow', lines('| a | b^ |', '|---|---|', '| 1 | 2 |'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| 1   | 2^   |'),
    )
    expect(run('nextRow', lines('| a | b |', '|---|---|', '| 1 | ^2 |'))).toBe(
      lines(...FORMATTED, '|     | ^    |'),
    )
  })

  it('Return after a row closing pipe goes to the first cell of the next row', () => {
    // Where a row typed by hand ends, so the next one starts at its beginning.
    expect(run('nextRow', lines('| a | b |', '|-|-|^'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| ^    |     |'),
    )
    expect(run('nextRow', lines(TABLE + '^'))).toBe(lines(...FORMATTED, '| ^    |     |'))
    expect(run('nextRow', lines(TABLE + ' ^', '| 3 | 4 |'))).toBe(
      lines(...FORMATTED, '| 3^   | 4   |'),
    )
    // At the end of a row without a closing pipe, as after one.
    expect(run('nextRow', lines('| a | b', '|-|-', '| 1 | 2^'))).toBe(
      lines(...FORMATTED, '| ^    |     |'),
    )
    expect(run('nextRow', lines('a | b', '--|--', '1 | 2 ^'))).toBe(
      lines(...FORMATTED, '| ^    |     |'),
    )
    // Before the end of the row's text the cursor keeps its column.
    expect(run('nextRow', lines('| a | b', '|-|-', '| 1 | ^2'))).toBe(
      lines(...FORMATTED, '|     | ^    |'),
    )
  })

  it('Return on the delimiter row goes to the first cell of the first row', () => {
    // A delimiter row has no cell text whose column is worth keeping.
    for (const delimiter of ['|-|-^', '--|--^', '|-|^-|', '| --- | -^-- |']) {
      expect(run('nextRow', lines('| a | b |', delimiter))).toBe(
        lines(FORMATTED[0]!, FORMATTED[1]!, '| ^    |     |'),
      )
      expect(run('nextRow', lines('| a | b |', delimiter, '| 1 | 2 |'))).toBe(
        lines(FORMATTED[0]!, FORMATTED[1]!, '| 1^   | 2   |'),
      )
    }
  })

  it('Return on an empty last row leaves the table below it', () => {
    expect(run('nextRow', lines('| a | b |', '|---|---|', '| 1 | 2 |', '|  | ^ |'))).toBe(
      lines(...FORMATTED, '', '^'),
    )
    expect(run('nextRow', lines(TABLE, '|  | ^ |', '', 'after'))).toBe(
      lines(...FORMATTED, '', '^', '', 'after'),
    )
  })

  it('Option+Return inserts a row below, in the same column', () => {
    expect(run('insertRowBelow', lines('| a | b |', '|---|---|', '| 1 | ^2 |', '| 3 | 4 |'))).toBe(
      lines(...FORMATTED, '|     | ^    |', '| 3   | 4   |'),
    )
    // Below the header is the first row.
    expect(run('insertRowBelow', lines('| ^a | b |', '|---|---|', '| 1 | 2 |'))).toBe(
      lines(FORMATTED[0]!, FORMATTED[1]!, '| ^    |     |', FORMATTED[2]!),
    )
  })
})

describe('row and column commands', () => {
  const T = lines('| h1 | h2 | h3 |', '|---|:-:|--:|', '| a | b | c |', '| d | e | f |')

  it('insert a row above, not above the header', () => {
    expect(run('insertRowAbove', T.replace('| d', '| ^d'))).toBe(
      lines(
        '| h1  | h2  |  h3 |',
        '| --- | :-: | --: |',
        '| a   |  b  |   c |',
        '| ^    |     |     |',
        '| d   |  e  |   f |',
      ),
    )
    expect(run('insertRowAbove', T.replace('h1', 'h^1'))).toBeNull()
  })

  it('delete a row, never the header', () => {
    expect(run('deleteRow', T.replace('| a', '| ^a'))).toBe(
      lines('| h1  | h2  |  h3 |', '| --- | :-: | --: |', '| d^   |  e  |   f |'),
    )
    // The last row: the cursor goes to the row above.
    expect(run('deleteRow', T.replace('| e', '| ^e'))).toBe(
      lines('| h1  | h2  |  h3 |', '| --- | :-: | --: |', '| a   |  b^  |   c |'),
    )
    expect(run('deleteRow', T.replace('h1', 'h^1'))).toBeNull()
    expect(run('deleteRow', T.replace('|:-:', '|:^-:'))).toBeNull()
  })

  it('move a row up and down, the cursor with it', () => {
    expect(run('moveRowDown', T.replace('| b', '| b^'))).toBe(
      lines(
        '| h1  | h2  |  h3 |',
        '| --- | :-: | --: |',
        '| d   |  e  |   f |',
        '| a   |  b^  |   c |',
      ),
    )
    expect(run('moveRowUp', T.replace('| f', '| ^f'))).toBe(
      lines(
        '| h1  | h2  |  h3 |',
        '| --- | :-: | --: |',
        '| d   |  e  |   ^f |',
        '| a   |  b  |   c |',
      ),
    )
    // Not past either end, and the header stays the header.
    expect(run('moveRowUp', T.replace('| a', '| ^a'))).toBeNull()
    expect(run('moveRowDown', T.replace('| d', '| ^d'))).toBeNull()
    expect(run('moveRowDown', T.replace('h1', 'h^1'))).toBeNull()
  })

  it('insert a column left or right of the cursor', () => {
    expect(run('insertColumnLeft', T.replace('| b', '| ^b'))).toBe(
      lines(
        '| h1  |     | h2  |  h3 |',
        '| --- | --- | :-: | --: |',
        '| a   | ^    |  b  |   c |',
        '| d   |     |  e  |   f |',
      ),
    )
    expect(run('insertColumnRight', T.replace('h3', 'h3^'))).toBe(
      lines(
        '| h1  | h2  |  h3 | ^    |',
        '| --- | :-: | --: | --- |',
        '| a   |  b  |   c |     |',
        '| d   |  e  |   f |     |',
      ),
    )
  })

  it('delete a column, keeping at least one', () => {
    expect(run('deleteColumn', T.replace('| c', '| ^c'))).toBe(
      lines('| h1  | h2  |', '| --- | :-: |', '| a   |  b^  |', '| d   |  e  |'),
    )
    expect(run('deleteColumn', lines('| ^a |', '|---|', '| 1 |'))).toBeNull()
  })

  it('move a column left and right, with its alignment', () => {
    expect(run('moveColumnLeft', T.replace('| c', '| c^'))).toBe(
      lines(
        '| h1  |  h3 | h2  |',
        '| --- | --: | :-: |',
        '| a   |   c^ |  b  |',
        '| d   |   f |  e  |',
      ),
    )
    expect(run('moveColumnRight', T.replace('| h1', '| ^h1'))).toBe(
      lines(
        '| h2  | ^h1  |  h3 |',
        '| :-: | --- | --: |',
        '|  b  | a   |   c |',
        '|  e  | d   |   f |',
      ),
    )
    expect(run('moveColumnLeft', T.replace('| a', '| ^a'))).toBeNull()
    expect(run('moveColumnRight', T.replace('| f', '| ^f'))).toBeNull()
  })

  it('set the alignment of the cursor column', () => {
    const t = lines('| h^1 | h2 |', '|---|---|', '| a | b |')
    expect(run('alignLeft', t)).toBe(lines('| h^1  | h2  |', '| :-- | --- |', '| a   | b   |'))
    expect(run('alignCenter', t)).toBe(lines('| h^1  | h2  |', '| :-: | --- |', '|  a  | b   |'))
    expect(run('alignRight', t)).toBe(lines('|  h^1 | h2  |', '| --: | --- |', '|   a | b   |'))
    expect(run('alignNone', lines('| h^1 |', '|:-:|', '| a |'))).toBe(
      lines('| h^1  |', '| --- |', '| a   |'),
    )
  })

  it('format the table, the cursor staying in its cell', () => {
    expect(run('format', lines('|a|b^b|', '|-|-|', '|c'))).toBe(
      lines('| a   | b^b  |', '| --- | --- |', '| c   |     |'),
    )
  })
})

describe('tables as written', () => {
  it('keep escaped pipes and pad ragged rows', () => {
    expect(run('format', lines('a \\| b | c^', '-|-', '| x', 'y | z | extra'))).toBe(
      lines(
        '| a \\| b | c^   |       |',
        '| ------ | --- | ----- |',
        '| x      |     |       |',
        '| y      | z   | extra |',
      ),
    )
  })

  it('pad wide characters by their display width', () => {
    const wide = String.fromCodePoint(0x4e2d, 0x6587)
    expect(run('format', lines(`| ${wide} | b^ |`, '|-|-|', '| abcde | c |'))).toBe(
      lines(`| ${wide}  | b^   |`, '| ----- | --- |', '| abcde | c   |'),
    )
  })

  it('keep the quote and list markers of their lines', () => {
    expect(run('insertRowBelow', lines('> | a | b |', '> |-|-|', '> | 1 | ^2 |'))).toBe(
      lines('> | a   | b   |', '> | --- | --- |', '> | 1   | 2   |', '> |     | ^    |'),
    )
    expect(run('nextCell', lines('- item', '', '  | a | b |', '  |-|-|', '  | 1 | 2^ |'))).toBe(
      lines(
        '- item',
        '',
        '  | a   | b   |',
        '  | --- | --- |',
        '  | 1   | 2   |',
        '  | ^    |     |',
      ),
    )
  })

  it('leave the text around the table alone', () => {
    expect(run('format', lines('before', '', '| a^ |', '|-|', '', 'after'))).toBe(
      lines('before', '', '| a^   |', '| --- |', '', 'after'),
    )
  })
})

describe('outside a table', () => {
  const ids = Object.keys(TABLE_COMMANDS) as TableCommandId[]
  const docs = [
    lines('plain^ text'),
    lines('^', TABLE),
    lines(TABLE, '', 'after^'),
    lines('```', '| a | b^ |', '|---|---|', '```'),
    lines('| not | a table^ |'),
  ]

  it('every command does nothing', () => {
    for (const doc of docs) {
      expect({ doc, inTable: inTable(state(doc)) }).toEqual({ doc, inTable: false })
      for (const id of ids)
        expect({ id, doc, result: run(id, doc) }).toEqual({ id, doc, result: null })
    }
  })

  it('knows when the cursor is in a table', () => {
    expect(inTable(state(lines('| a^ |', '|-|')))).toBe(true)
    expect(inTable(state(lines('> ^| a |', '> |-|')))).toBe(true)
    expect(inTable(state(lines('| a |', '|-|', '| 1 |^')))).toBe(true)
  })
})

describe('transactions', () => {
  const ids = Object.keys(TABLE_COMMANDS) as TableCommandId[]

  it('each command is one transaction and one undo step', () => {
    const doc = lines(
      '| h1 | h2 | h3 |',
      '|---|---|---|',
      '| a | b | c |',
      '| d | e | f |',
      '| g | h | i |',
    )
    for (const id of ids) {
      let s = state('', [noteMarkdown, history()])
      // Typing right before and right after: neither joins the command's step.
      s = s.update({ changes: { from: 0, insert: doc }, userEvent: 'input.type' }).state
      const at = doc.indexOf('| e') + 3
      s = s.update({ selection: EditorSelection.cursor(at), userEvent: 'select' }).state
      const spec = TABLE_COMMANDS[id](s)
      expect({ id, spec }).not.toEqual({ id, spec: null })
      const edited = s.update(spec as TransactionSpec)
      expect({ id, format: edited.isUserEvent('input.format') }).toEqual({ id, format: true })
      const end = edited.state.selection.main.head
      let after = edited.state.update({
        changes: { from: end, insert: 'x' },
        userEvent: 'input.type',
      }).state
      const steps: string[] = []
      for (let i = 0; i < 3; i++) {
        undo({ state: after, dispatch: (tr: Transaction) => (after = tr.state) })
        steps.push(after.doc.toString())
      }
      expect({ id, steps }).toEqual({ id, steps: [edited.state.doc.toString(), doc, ''] })
    }
  })

  it('only change what differs', () => {
    const s = state(lines('intro', '', '| a   | b   |', '| --- | --- |', '| 1   | 2^ |'))
    const tr = s.update(TABLE_COMMANDS.format(s)!)
    const changed: [number, number][] = []
    tr.changes.iterChangedRanges((from, to) => changed.push([from, to]))
    expect(changed).toEqual([[s.doc.length - 1, s.doc.length - 1]])
  })

  it('never splits an emoji between changed and kept text', () => {
    // Both emoji start with the same high surrogate.
    const [smile, grin] = [String.fromCodePoint(0x1f600), String.fromCodePoint(0x1f603)]
    const s = state(lines('| a   |', '| --- |', `| ${smile}^  |`, `| ${grin}  |`))
    const tr = s.update(TABLE_COMMANDS.moveRowDown(s)!)
    const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      expect(isLow(s.doc.sliceString(fromA, fromA + 1).charCodeAt(0))).toBe(false)
      expect(isLow(s.doc.sliceString(toA, toA + 1).charCodeAt(0))).toBe(false)
      expect(isLow(inserted.toString().charCodeAt(0))).toBe(false)
    })
    expect(tr.state.doc.toString()).toBe(
      lines('| a   |', '| --- |', `| ${grin}  |`, `| ${smile}  |`),
    )
  })

  it('moving without changing the text only moves the cursor', () => {
    const s = state(lines('| a^   | b   |', '| --- | --- |'))
    const tr = s.update(TABLE_COMMANDS.nextCell(s)!)
    expect(tr.docChanged).toBe(false)
    expect(show(tr.state)).toBe(lines('| a   | b^   |', '| --- | --- |'))
  })
})

describe('the key handlers', () => {
  const view = (s: EditorState) => {
    const dispatched: EditorState[] = []
    const v = {
      state: s,
      dispatch: (spec: TransactionSpec) => dispatched.push(s.update(spec).state),
    }
    return { v: v as unknown as EditorView, dispatched }
  }

  it('act in a table and pass the key on elsewhere', () => {
    const inside = view(state(lines('| a^ |', '|-|')))
    expect(tableCommand('nextCell')(inside.v)).toBe(true)
    expect(inside.dispatched.map(show)).toEqual([lines('| a   |', '| --- |', '| ^    |')])
    const outside = view(state('plain^'))
    expect(tableCommand('nextCell')(outside.v)).toBe(false)
    expect(tableCommand('nextRow')(outside.v)).toBe(false)
    expect(outside.dispatched).toEqual([])
  })

  it('keep a key that cannot act in the table from reaching the editor', () => {
    // Option+Up on the first row must not move the line above the delimiter row.
    const first = view(state(lines('| a |', '|-|', '| ^1 |', '| 2 |')))
    expect(tableCommand('moveRowUp')(first.v)).toBe(true)
    expect(first.dispatched).toEqual([])
    const outside = view(state('plain^'))
    expect(tableCommand('moveRowUp')(outside.v)).toBe(false)
  })

  it('leave a selection over several lines to the editor', () => {
    const across = view(state(lines('| «a |', '|-|', '| 1» |')))
    expect(tableCommand('nextRow')(across.v)).toBe(false)
    expect(tableCommand('moveRowUp')(across.v)).toBe(false)
    expect(across.dispatched).toEqual([])
    // Within a cell it is the table's.
    const within = view(state(lines('| «ab» | c |', '|-|-|')))
    expect(tableCommand('nextCell')(within.v)).toBe(true)
  })

  it('leave Return at the start of a row to the editor, which opens a line above it', () => {
    // What Return does once the table key passes it on: the Markdown keymap's
    // newline, which continues a quote or list, else the default keymap's.
    const returnKey = (marked: string) => {
      const s = state(marked)
      const handled = view(s)
      expect(tableCommand('nextRow')(handled.v)).toBe(false)
      expect(handled.dispatched).toEqual([])
      let after = s
      const editor = { state: s, dispatch: (tr: Transaction) => (after = tr.state) }
      const v = editor as unknown as EditorView
      expect(insertNewlineContinueMarkup(v) || insertNewlineAndIndent(v)).toBe(true)
      return show(after)
    }
    // Before the header of a table at the top of a note: a line above it, the table as written.
    expect(returnKey(lines('^| a | b |', '|---|---|', '| 1 | 2 |'))).toBe(
      lines('', '^| a | b |', '|---|---|', '| 1 | 2 |'),
    )
    expect(returnKey(lines('^a | b', '---|---', '1 | 2'))).toBe(
      lines('', '^a | b', '---|---', '1 | 2'),
    )
    // Before a row: a blank line above it, which ends the table there.
    expect(returnKey(lines(TABLE, '^| 3 | 4 |'))).toBe(lines(TABLE, '', '^| 3 | 4 |'))
    // After a quote marker, or before it.
    expect(returnKey(lines('> ^| a |', '> |-|'))).toBe(lines('>', '> ^| a |', '> |-|'))
    expect(returnKey(lines('^> | a |', '> |-|'))).toBe(lines('', '^> | a |', '> |-|'))
    // Past the opening pipe Return is the table's.
    const inside = view(state(lines('|^ a | b |', '|---|---|', '| 1 | 2 |')))
    expect(tableCommand('nextRow')(inside.v)).toBe(true)
    expect(inside.dispatched.map(show)).toEqual([
      lines(FORMATTED[0]!, FORMATTED[1]!, '| 1^   | 2   |'),
    ])
  })

  it('leave several cursors to the editor', () => {
    const several = view(state(lines('| a^ | b^ |', '|-|-|')))
    expect(tableCommand('nextCell')(several.v)).toBe(false)
    expect(several.dispatched).toEqual([])
  })
})
