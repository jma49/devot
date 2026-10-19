// Table commands: each finds the GFM table the cursor is in, edits it as data (table.ts) and prints it back
// formatted, as one transaction (`input.format`, isolated history). Outside a table every command does
// nothing and its key goes on to the editor's other bindings (Tab keeps leaving the editor, Return a new line).
import { completionStatus } from '@codemirror/autocomplete'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  Prec,
  StateEffect,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { textDiff } from '../../../core/text'
import { editorTableKeys } from '../commands/registry'
import { registryKeys } from './registryKeys'
import { COMMAND_PARSE_MS, spec, type FormatCommand } from './formatContext'
import {
  cellAt,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  printTable,
  setAlign,
  type Align,
  type Table,
} from './table'

export type TableCommandId =
  | 'nextCell'
  | 'previousCell'
  | 'nextRow'
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'deleteRow'
  | 'moveRowUp'
  | 'moveRowDown'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteColumn'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignNone'
  | 'format'

export interface Located {
  from: number
  to: number
  prefixes: string[]
  table: Table
  /** The cursor's line in the table (0 the header, 1 the delimiter row, 2 on the rows). */
  line: number
  column: number
  offset: number
  rowStart: boolean
  rowEnd: boolean
  /** Whether nothing but spaces follows the cursor on its line (with or without a closing pipe). */
  lineEnd: boolean
}

export interface Target {
  table: Table
  line: number
  column: number
  offset: number | 'end'
  rowEnd?: boolean
  /** Return on an empty last row: drop it and leave the table below it. */
  exit?: boolean
}

/**
 * Marks the line (by its number) of an empty row that Tab, Return or Insert
 * Row left the cursor in, where a row may be typed by hand (tableTyping.ts).
 */
export const enterEmptyRow = StateEffect.define<number>()

const ROW_NODES = new Set(['TableHeader', 'TableDelimiter', 'TableRow'])

function tableNode(tree: Tree, positions: readonly [number, -1 | 1][]): SyntaxNode | null {
  for (const [pos, side] of positions) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent)
      if (n.name === 'Table') return n
  }
  return null
}

/**
 * The table around the main cursor, or null. Every line of a table holds a
 * pipe, so a line without one is outside any table (the common case, found
 * without the parser: these keys are Tab and Return). Otherwise the tree is
 * parsed through the end of the run of lines with a pipe, which holds the
 * whole table; null when the parser cannot get there in time.
 */
export function locate(state: EditorState): Located | null {
  const { doc } = state
  const head = state.selection.main.head
  const cursorLine = doc.lineAt(head)
  if (!cursorLine.text.includes('|')) return null
  let last = cursorLine
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1)
    if (!next.text.includes('|')) break
    last = next
  }
  const tree = ensureSyntaxTree(state, last.to, COMMAND_PARSE_MS)
  if (!tree) return null
  // The cursor may sit before a quote marker, which is outside the table on its first line.
  const node = tableNode(tree, [
    [head, -1],
    [head, 1],
    [cursorLine.to, -1],
  ])
  if (!node) return null
  const prefixes: string[] = []
  const texts: string[] = []
  let first = -1
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!ROW_NODES.has(child.name)) continue
    const line = doc.lineAt(child.from)
    if (first < 0) first = line.number
    if (line.number !== first + texts.length) return null
    if ((texts.length === 1) !== (child.name === 'TableDelimiter')) return null
    prefixes.push(doc.sliceString(line.from, child.from))
    texts.push(doc.sliceString(child.from, line.to))
  }
  const table = parseTable(texts)
  if (!table) return null
  const line = cursorLine.number - first
  if (line < 0 || line >= texts.length) return null
  const ch = head - cursorLine.from - prefixes[line]!.length
  const { column, offset, past } = cellAt(texts[line]!, ch)
  return {
    from: doc.line(first).from,
    to: doc.line(first + texts.length - 1).to,
    prefixes,
    table,
    line,
    column: Math.min(column, table.align.length - 1),
    offset,
    rowStart: ch <= 0,
    rowEnd: past,
    lineEnd: ch >= texts[line]!.replace(/[ \t]+$/, '').length,
  }
}

/** Lines of the table: 0 the header, 1 the delimiter row, then a line per row. */
export const FIRST_ROW = 2

const rowIndex = (at: { line: number }) => (at.line < FIRST_ROW ? -1 : at.line - FIRST_ROW)

function layout(at: Located, target: Target): { text: string; cursor: number } {
  const printed = printTable(target.table)
  const prefix = (i: number) => at.prefixes[Math.min(i, at.prefixes.length - 1)]!
  const lines = printed.lines.map((line, i) => prefix(i) + line)
  let cursor: number
  if (target.exit) {
    // A blank line ends the table; the cursor starts a new block after it.
    const markers = prefix(lines.length)
    lines.push(markers.trimEnd(), markers)
    cursor = lines.join('\n').length
  } else {
    cursor = 0
    for (let i = 0; i < target.line; i++) cursor += lines[i]!.length + 1
    if (target.rowEnd) cursor += lines[target.line]!.length
    else {
      const span = printed.cells[target.line]![target.column]!
      const length = span.to - span.from
      const offset = target.offset === 'end' ? length : Math.min(target.offset, length)
      cursor += prefix(target.line).length + span.from + offset
    }
  }
  return { text: lines.join('\n'), cursor }
}

/**
 * `target`'s table written over the located one: the change (null when the
 * text stays as it is) and where the cursor goes. The change is only what
 * differs (never half an emoji), so the rest keeps its place in Yjs.
 */
export function rewrite(
  state: EditorState,
  at: Located,
  target: Target,
): { change: { from: number; to: number; insert: string } | null; cursor: number } {
  const { text, cursor } = layout(at, target)
  const old = state.doc.sliceString(at.from, at.to)
  if (text === old) return { change: null, cursor: at.from + cursor }
  const diff = textDiff(old, text)
  const from = at.from + diff.index
  return { change: { from, to: from + diff.remove, insert: diff.insert }, cursor: at.from + cursor }
}

function write(
  state: EditorState,
  at: Located,
  target: Target,
  entersRow: boolean,
): ReturnType<FormatCommand> {
  const { change, cursor } = rewrite(state, at, target)
  const selection = EditorSelection.single(cursor)
  const row = entersRow && !target.exit ? target.table.rows[rowIndex(target)] : undefined
  const effects = row?.every((cell) => cell === '')
    ? enterEmptyRow.of(state.doc.lineAt(at.from).number + target.line)
    : []
  if (!change) return { selection, effects, userEvent: 'select', scrollIntoView: true }
  return { ...spec(change, selection), effects }
}

/** The line the cursor's row is on; the delimiter row counts as the header. */
const rowLine = (at: Located) => (at.line === 1 ? 0 : at.line)
const lastLine = (table: Table) => FIRST_ROW + table.rows.length - 1

function below(at: Located): { table: Table; line: number } {
  const line = rowLine(at) === 0 ? FIRST_ROW : rowLine(at) + 1
  const table = line > lastLine(at.table) ? insertRow(at.table, at.table.rows.length) : at.table
  return { table, line }
}

type TableEdit = (at: Located) => Target | null

const keep = (at: Located, table: Table, column = at.column, line = at.line): Target => ({
  table,
  line,
  column,
  offset: at.offset,
})

const align =
  (a: Align): TableEdit =>
  (at) =>
    keep(at, setAlign(at.table, at.column, a))

const EDITS: Record<TableCommandId, TableEdit> = {
  nextCell: (at) => {
    if (at.column < at.table.align.length - 1)
      return { table: at.table, line: rowLine(at), column: at.column + 1, offset: 'end' }
    return { ...below(at), column: 0, offset: 'end' }
  },
  previousCell: (at) => {
    const line = rowLine(at)
    if (at.column > 0) return { table: at.table, line, column: at.column - 1, offset: 'end' }
    if (line === 0) return { table: at.table, line, column: 0, offset: 'end' }
    const previous = line === FIRST_ROW ? 0 : line - 1
    return { table: at.table, line: previous, column: at.table.align.length - 1, offset: 'end' }
  },
  nextRow: (at) => {
    const row = rowIndex(at)
    const lastRow = at.table.rows.length - 1
    if (row >= 0 && row === lastRow && at.table.rows[row]!.every((cell) => cell === ''))
      return { table: deleteRow(at.table, row), line: 0, column: 0, offset: 0, exit: true }
    // At the end of a row (where a row typed by hand ends, with or without
    // its closing pipe) and on the delimiter row, which has no cell text
    // whose column is worth keeping, the next row starts at its beginning.
    const first = at.line === 1 || at.lineEnd
    return { ...below(at), column: first ? 0 : at.column, offset: 'end' }
  },
  insertRowBelow: (at) => {
    const row = rowIndex(at) + 1
    const table = insertRow(at.table, row)
    return { table, line: FIRST_ROW + row, column: at.column, offset: 'end' }
  },
  insertRowAbove: (at) => {
    const row = rowIndex(at)
    if (row < 0) return null
    return { table: insertRow(at.table, row), line: at.line, column: at.column, offset: 'end' }
  },
  deleteRow: (at) => {
    const row = rowIndex(at)
    if (row < 0) return null
    const table = deleteRow(at.table, row)
    const line = row < table.rows.length ? at.line : row > 0 ? at.line - 1 : 0
    return { table, line, column: at.column, offset: 'end' }
  },
  moveRowUp: (at) => {
    const row = rowIndex(at)
    if (row < 1) return null
    return keep(at, moveRow(at.table, row, row - 1), at.column, at.line - 1)
  },
  moveRowDown: (at) => {
    const row = rowIndex(at)
    if (row < 0 || row >= at.table.rows.length - 1) return null
    return keep(at, moveRow(at.table, row, row + 1), at.column, at.line + 1)
  },
  insertColumnLeft: (at) => ({
    table: insertColumn(at.table, at.column),
    line: at.line,
    column: at.column,
    offset: 'end',
  }),
  insertColumnRight: (at) => ({
    table: insertColumn(at.table, at.column + 1),
    line: at.line,
    column: at.column + 1,
    offset: 'end',
  }),
  deleteColumn: (at) => {
    const columns = at.table.align.length
    if (columns < 2) return null
    const table = deleteColumn(at.table, at.column)
    return { table, line: at.line, column: Math.min(at.column, columns - 2), offset: 'end' }
  },
  moveColumnLeft: (at) =>
    at.column < 1 ? null : keep(at, moveColumn(at.table, at.column, at.column - 1), at.column - 1),
  moveColumnRight: (at) =>
    at.column >= at.table.align.length - 1
      ? null
      : keep(at, moveColumn(at.table, at.column, at.column + 1), at.column + 1),
  alignLeft: align('left'),
  alignCenter: align('center'),
  alignRight: align('right'),
  alignNone: align('none'),
  format: (at) => keep(at, at.table),
}

const ENTER_ROW: ReadonlySet<TableCommandId> = new Set([
  'nextCell',
  'nextRow',
  'insertRowBelow',
  'insertRowAbove',
])

function edit(state: EditorState, at: Located, id: TableCommandId): ReturnType<FormatCommand> {
  const target = EDITS[id](at)
  return target && write(state, at, target, ENTER_ROW.has(id))
}

export const TABLE_COMMANDS = Object.fromEntries(
  (Object.keys(EDITS) as TableCommandId[]).map((id) => [
    id,
    (state: EditorState) => {
      const at = locate(state)
      return at && edit(state, at, id)
    },
  ]),
) as Record<TableCommandId, FormatCommand>

export interface TableBarStatus {
  disabled: ReadonlySet<TableCommandId>
  align: Align
}

const BAR_CHECKED: readonly TableCommandId[] = [
  'moveRowUp',
  'moveRowDown',
  'moveColumnLeft',
  'moveColumnRight',
  'deleteRow',
  'deleteColumn',
]

export function tableBarStatus(state: EditorState): TableBarStatus | null {
  const at = locate(state)
  if (!at) return null
  const disabled = new Set(BAR_CHECKED.filter((id) => EDITS[id](at) === null))
  if (at.table.rows.length < 2) disabled.add('deleteRow')
  return { disabled, align: at.table.align[at.column] ?? 'none' }
}

export function inTable(state: EditorState): boolean {
  return locate(state) !== null
}

/**
 * A table key for CodeMirror. False (the key goes on) outside a table, with
 * several cursors or a selection over several lines (Return replaces it,
 * Option+Up moves its lines), or while the completion list is open. In a
 * table a command that cannot act there (Option+Up on the first row) still
 * takes the key, so the editor's own binding cannot move a line out of it.
 * Return before a row's first character goes on too: the editor's new line
 * opens a line above the row (above a table at the top of a note, or a
 * blank line that ends the table there).
 */
export function tableCommand(id: TableCommandId): Command {
  return (view) => {
    const { state } = view
    const { from, to } = state.selection.main
    if (state.selection.ranges.length > 1 || completionStatus(state) === 'active') return false
    if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return false
    const at = locate(state)
    if (!at || (id === 'nextRow' && at.rowStart)) return false
    const tr = edit(state, at, id)
    if (tr) view.dispatch(tr)
    return true
  }
}

/** The table keys from the command registry, above the Markdown keymap (whose Return continues lists). */
export const tableKeymap: () => Extension = registryKeys(() =>
  Prec.highest(
    keymap.of(editorTableKeys().map(({ command, key }) => ({ key, run: tableCommand(command) }))),
  ),
)
