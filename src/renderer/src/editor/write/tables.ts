// Write mode's tables, as data: where each cell's text is in the source, what
// shows and what the caret steps over when the table is drawn as a grid, and
// the edit that keeps the source formatted after typing in a cell. Pure: read
// from the syntax tree, the selection and the transaction, so the mapping is
// tested over Markdown without an editor.
import { syntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  type SelectionRange,
  StateField,
  type ChangeDesc,
  type ChangeSpec,
  type EditorState,
  type Text,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { textDiff } from '../../../../core/text'
import { parseAlign, printTable, splitRow, type Align } from '../table'
import { firstReaching, type Span as Lines } from './changes'

/** A cell: the source between its pipes, and its text in it without the padding. */
export interface TableCell {
  from: number
  to: number
  textFrom: number
  textTo: number
}

export interface TableLine {
  from: number
  to: number
  /** What comes before the row on its line (quote marks, a list's indent), kept when it is printed again. */
  prefix: string
  /** Empty on the delimiter row; never more than the table's columns. */
  cells: TableCell[]
  /** The row's cells past the delimiter row's, which GFM leaves out: hidden, not edited. */
  extra: boolean
}

export interface WriteTable {
  from: number
  to: number
  /** The header, the delimiter row, then a line per row. */
  lines: TableLine[]
  align: Align[]
}

export const DELIMITER = 1

export type Span = readonly [number, number]

const ROW_NODES = new Set(['TableHeader', 'TableDelimiter', 'TableRow'])
// The blocks a table can be in.
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])

const cache = new WeakMap<Text, { tree: Tree; tables: WriteTable[] }>()

/** The GFM tables Write mode draws as a grid, in the note's order, in lists and quotes too. */
export function writeTablesOf(state: EditorState, tree = syntaxTree(state)): readonly WriteTable[] {
  const known = cache.get(state.doc)
  if (known?.tree === tree) return known.tables
  const tables = tablesIn(state.doc, tree, 0, state.doc.length)
  cache.set(state.doc, { tree, tables })
  return tables
}

/** The tables whose nodes meet `from`..`to`. */
function tablesIn(doc: Text, tree: Tree, from: number, to: number): WriteTable[] {
  const tables: WriteTable[] = []
  tree.iterate({
    from,
    to,
    enter: (ref) => {
      if (ref.name === 'Table') {
        const table = read(doc, ref.node)
        if (table) tables.push(table)
        return false
      }
      return CONTAINERS.has(ref.name)
    },
  })
  return tables
}

/**
 * Keeps the tables of a step's start for its end, read again only over
 * `changed` (sorted spans of the new note, whole lines, from `changedSpans`).
 * Returns the spans read again; null when the start's tables were never
 * read: they are read whole when asked for.
 */
export function carryWriteTables(tr: Transaction, changed: readonly Lines[]): Lines[] | null {
  const { state } = tr
  const tree = syntaxTree(state)
  if (cache.get(state.doc)?.tree === tree) return []
  const before = cache.get(tr.startState.doc)
  if (before?.tree !== syntaxTree(tr.startState)) return null
  const reread: Lines[] = []
  const old = before.tables.map((t) => movedTable(t, tr.changes))
  const tables: WriteTable[] = []
  let k = 0
  for (let r = 0; r < changed.length;) {
    let [from, to] = changed[r++]!
    while (k < old.length && old[k]!.to < from) tables.push(old[k++]!)
    let found: WriteTable[] = []
    for (let grew = true; grew;) {
      grew = false
      for (; k < old.length && old[k]!.from <= to; k++) {
        from = Math.min(from, old[k]!.from)
        to = Math.max(to, old[k]!.to)
      }
      while (r < changed.length && changed[r]![0] <= to) to = Math.max(to, changed[r++]![1])
      found = tablesIn(state.doc, tree, from, to)
      for (const table of found) {
        if (table.from >= from && table.to <= to) continue
        from = Math.min(from, table.from)
        to = Math.max(to, table.to)
        grew = true
      }
    }
    tables.push(...found)
    reread.push([from, to])
  }
  while (k < old.length) tables.push(old[k++]!)
  cache.set(state.doc, { tree, tables })
  return reread
}

function read(doc: Text, node: SyntaxNode): WriteTable | null {
  const lines: TableLine[] = []
  let first = -1
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!ROW_NODES.has(child.name)) continue
    const line = doc.lineAt(child.from)
    if (first < 0) first = line.number
    if (line.number !== first + lines.length) return null
    if ((lines.length === DELIMITER) !== (child.name === 'TableDelimiter')) return null
    const at = child.from
    const cells = splitRow(doc.sliceString(at, line.to)).map((cell) => ({
      from: at + cell.from,
      to: at + cell.to,
      textFrom: at + cell.textFrom,
      textTo: at + cell.textFrom + cell.text.length,
    }))
    const prefix = doc.sliceString(line.from, at)
    lines.push({ from: line.from, to: line.to, prefix, cells, extra: false })
  }
  if (lines.length <= DELIMITER) return null
  const align: Align[] = []
  for (const cell of lines[DELIMITER]!.cells) {
    const a = parseAlign(doc.sliceString(cell.from, cell.to))
    if (a === null) return null
    align.push(a)
  }
  lines[DELIMITER]!.cells = []
  const columns = align.length
  for (const [i, line] of lines.entries()) {
    if (i === DELIMITER) continue
    if (line.cells.length === 0 || (i === 0 && line.cells.length !== columns)) return null
    if (line.cells.length > columns) {
      line.cells = line.cells.slice(0, columns)
      line.extra = true
    }
  }
  return { from: lines[0]!.from, to: lines[lines.length - 1]!.to, lines, align }
}

/** The tables shown as a grid: all but those several cursors are in, which show their source. */
export function shownTable(state: EditorState, table: WriteTable): boolean {
  const { ranges } = state.selection
  return ranges.length < 2 || !ranges.some((r) => r.from <= table.to && r.to >= table.from)
}

/** The single caret, if the selection is one. */
export function caretOf(selection: EditorSelection): number | null {
  const { ranges, main } = selection
  return ranges.length === 1 && main.empty ? main.head : null
}

/** Where an empty cell shows the caret: after its first space, where a printed cell's text starts. */
const blankPoint = (cell: TableCell) => (cell.to - cell.from >= 2 ? cell.from + 1 : cell.from)

/**
 * What a cell shows: its text, and the spaces typed after it while the caret
 * is there (formatting would trim them until the next character comes). An
 * empty cell shows a point.
 */
export function visibleSpan(cell: TableCell, caret: number | null): Span {
  if (cell.textTo === cell.textFrom || cell.textFrom >= cell.to) {
    const at = blankPoint(cell)
    return [at, at]
  }
  const end = caret !== null && caret > cell.textTo && caret <= cell.to ? caret : cell.textTo
  return [cell.textFrom, end]
}

const rowLines = (table: WriteTable) => table.lines.filter((_, i) => i !== DELIMITER)

function gaps(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = []
  let at = from
  for (const [a, b] of spans) {
    if (a > at) out.push([at, a])
    at = Math.max(at, b)
  }
  if (to > at) out.push([at, to])
  return out
}

const envelope = (table: WriteTable, length: number): Span => [
  Math.max(0, table.from - 1),
  Math.min(length, table.to + 1),
]

/**
 * What the caret steps over, as one unit each: everything between one cell's
 * shown text and the next, across line breaks too, and the line breaks
 * around the table, so an arrow goes from cell to cell and into and out of it.
 */
export function atomicSpans(table: WriteTable, caret: number | null, length: number): Span[] {
  const spans = rowLines(table).flatMap((line) => line.cells.map((c) => visibleSpan(c, caret)))
  const [from, to] = envelope(table, length)
  return gaps(spans, from, to)
}

/**
 * Per row line, the source each cell's box takes: from its pipe (the first
 * from the line's start) to the next pipe, the last to the line's end. Every
 * character of the line is in a box, so the hidden ones are drawn inside it,
 * and the place right before a pipe is still in its cell; the header's last
 * box takes the delimiter row too.
 */
export function cellBoxes(table: WriteTable): { line: TableLine; boxes: Span[] }[] {
  return rowLines(table).map((line, i) => {
    const end = i === 0 ? table.lines[DELIMITER]!.to : line.to
    const last = line.cells.length - 1
    const boxes = line.cells.map((cell, k): Span => [
      k === 0 ? line.from : cell.from - 1,
      k === last ? end : cell.to,
    ])
    return { line, boxes }
  })
}

export type CellTint = 'caret' | 'selected' | null

const inOneCell = (table: WriteTable, from: number, to: number) =>
  table.lines.some((line) => line.cells.some((c) => from >= c.from && to <= c.to))

/** The selection's ranges that take whole cells of `table`: those that meet it and leave a cell. */
export function crossingRanges(
  table: WriteTable,
  selection: EditorSelection,
): readonly SelectionRange[] {
  return selection.ranges.filter(
    (r) => !r.empty && r.from < table.to && r.to > table.from && !inOneCell(table, r.from, r.to),
  )
}

/**
 * Per row of `cellBoxes`, each box's tint: the caret's cell carries the active
 * line, and every cell a selection meets once it leaves a cell is selected
 * whole. A selection inside one cell is drawn as text.
 */
export function cellTints(table: WriteTable, selection: EditorSelection): CellTint[][] {
  const caret = caretOf(selection)
  const crossing = crossingRanges(table, selection)
  return cellBoxes(table).map(({ boxes }) =>
    boxes.map(([from, to], k): CellTint => {
      if (crossing.some((r) => r.from < to && r.to > from)) return 'selected'
      // The place right before a pipe is the cell's end, not the next cell's start.
      const inBox = caret !== null && caret <= to && (caret > from || (k === 0 && caret === from))
      return inBox ? 'caret' : null
    }),
  )
}

/** Whether a selection that takes whole cells runs to the end of `line`, where a short row's missing cells are drawn. */
export function reachesRowEnd(
  table: WriteTable,
  line: TableLine,
  selection: EditorSelection,
): boolean {
  return crossingRanges(table, selection).some((r) => r.from < line.to && r.to >= line.to)
}

/** The source a cell's box does not show: pipes, padding and the delimiter row. */
export function hiddenSpans(table: WriteTable, caret: number | null): Span[] {
  return cellBoxes(table).flatMap(({ line, boxes }) =>
    boxes.flatMap(([from, to], k) => gaps([visibleSpan(line.cells[k]!, caret)], from, to)),
  )
}

/**
 * The structure an edit in a cell may not touch: the pipes, the row
 * prefixes, the delimiter row and the line breaks in and around the table.
 * An insertion at either end of one of these is kept: that is a cell's edge.
 */
export function structureSpans(table: WriteTable, length: number): Span[] {
  const spans = rowLines(table).flatMap((line) => line.cells.map((c): Span => [c.from, c.to]))
  const [from, to] = envelope(table, length)
  return gaps(spans, from, to)
}

/**
 * Where a caret put on the table's structure or padding (by a click, Home,
 * End) goes: to the nearest end of a cell's text. Spaces typed at a text's
 * end are not reached this way: typing moves the caret, not a selection.
 */
export function caretInCell(table: WriteTable, pos: number): number | null {
  if (pos < table.from || pos > table.to) return null
  const index = table.lines.findIndex((line) => pos >= line.from && pos <= line.to)
  if (index < 0) return null
  const lastOf = (line: TableLine) => visibleSpan(line.cells[line.cells.length - 1]!, null)[1]
  if (index === DELIMITER) return lastOf(table.lines[0]!)
  const line = table.lines[index]!
  const first = line.cells[0]!
  if (pos < first.from) return visibleSpan(first, null)[0]
  if (pos > line.cells[line.cells.length - 1]!.to) return lastOf(line)
  const cell = line.cells.find((c) => pos >= c.from && pos <= c.to)!
  const [shownFrom, shownTo] = visibleSpan(cell, null)
  const target = Math.min(Math.max(pos, shownFrom), shownTo)
  return target === pos ? null : target
}

// Typing in a cell. GFM ends a cell at a pipe and a row at a line break, so a
// pipe typed or pasted into a cell is written escaped, and a line break as a
// space; then the table is printed again as the table commands print it.

const BACKSLASH = 92
const PIPE = 124
const TRIM_START = /^[ \t]+/
const TRIM_END = /[ \t]+$/

/** A cell's text as GFM can keep it: its pipes escaped and its line breaks spaces. */
export function cellSource(raw: string): string {
  let out = ''
  let slashes = 0
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code === 10 || code === 13) {
      if (code === 13 && raw.charCodeAt(i + 1) === 10) continue
      out += ' '
      slashes = 0
      continue
    }
    if (code === PIPE && slashes % 2 === 0) out += '\\'
    out += raw[i]
    slashes = code === BACKSLASH ? slashes + 1 : 0
  }
  return out
}

/**
 * The cell text `raw` prints as, and where in it a caret `caret` characters
 * into `raw` is. Spaces typed before the caret at the end of the text stay
 * until the next character, so a space can be typed.
 */
export function cellEdit(raw: string, caret: number | null): { text: string; offset: number } {
  const source = cellSource(raw)
  const lead = source.length - source.replace(TRIM_START, '').length
  const end = Math.max(lead, source.replace(TRIM_END, '').length)
  if (caret === null) return { text: source.slice(lead, end), offset: 0 }
  const at = cellSource(raw.slice(0, caret)).length
  if (at <= lead) return { text: source.slice(lead, end), offset: 0 }
  return { text: source.slice(lead, Math.max(end, at)), offset: at - lead }
}

/** The tables, in order, that a change meets, or comes within `margin` of. */
export function tablesTouched(
  tables: readonly WriteTable[],
  changes: ChangeDesc,
  margin = 0,
): WriteTable[] {
  const out: WriteTable[] = []
  let next = 0
  changes.iterChangedRanges((fromA, toA) => {
    let i = Math.max(next, firstReaching(tables, fromA - margin))
    for (; i < tables.length && tables[i]!.from - margin <= toA; i++) out.push(tables[i]!)
    next = Math.max(next, i)
  })
  return out
}

/** Every change of `changes` that touches `table` lies inside one of its cells. */
function editsCells(changes: ChangeSet, table: WriteTable): 'none' | 'cells' | 'other' {
  const cells = rowLines(table).flatMap((line) => line.cells)
  let result: 'none' | 'cells' | 'other' = 'none'
  changes.iterChangedRanges((fromA, toA) => {
    if (result === 'other' || toA < table.from || fromA > table.to) return
    const inside = cells.some((c) => c.from <= fromA && toA <= c.to)
    result = inside ? 'cells' : 'other'
  })
  return result
}

function movedTable(table: WriteTable, changes: ChangeDesc): WriteTable {
  if (changes.touchesRange(table.from, table.to)) return mapTable(table, changes)
  const by = changes.mapPos(table.from) - table.from
  if (by === 0) return table
  return {
    from: table.from + by,
    to: table.to + by,
    align: table.align,
    lines: table.lines.map((line) => ({
      ...line,
      from: line.from + by,
      to: line.to + by,
      cells: line.cells.map((c) => ({
        from: c.from + by,
        to: c.to + by,
        textFrom: c.textFrom + by,
        textTo: c.textTo + by,
      })),
    })),
  }
}

function mapTable(table: WriteTable, changes: ChangeDesc): WriteTable {
  const before = (pos: number) => changes.mapPos(pos, -1)
  const after = (pos: number) => changes.mapPos(pos, 1)
  return {
    from: before(table.from),
    to: after(table.to),
    align: table.align,
    lines: table.lines.map((line) => ({
      ...line,
      from: before(line.from),
      to: after(line.to),
      cells: line.cells.map((c) => ({
        from: before(c.from),
        to: after(c.to),
        textFrom: before(c.textFrom),
        textTo: after(c.textTo),
      })),
    })),
  }
}

/**
 * The shown tables as they were when an input method's composition began,
 * mapped through it. Nothing is printed inside a composition, so a pipe it
 * typed would end its cell: the first edit after it prints these tables, the
 * cells read from where they were.
 */
export const composedTables = StateField.define<readonly WriteTable[] | null>({
  create: () => null,
  update(value, tr) {
    if (tr.isUserEvent('input.type.compose')) {
      const start = tr.startState
      const base = value ?? writeTablesOf(start).filter((t) => shownTable(start, t))
      return base.map((t) => mapTable(t, tr.changes))
    }
    if (!value || !tr.docChanged) return value
    if (tr.annotation(Transaction.userEvent) !== undefined) return null
    return value.map((t) => mapTable(t, tr.changes))
  },
})

/**
 * The edit that follows a user's edit in the cells of shown tables: each
 * table it touched printed again (padded columns, as Tab prints it), as
 * changes to the lines that differ, and the caret at its place in its cell.
 * Null when there is nothing to do. Applied after `tr`, in the same
 * transaction, so undo takes both back as one step.
 */
export function formatAfter(tr: Transaction): TransactionSpec | null {
  if (!tr.docChanged) return null
  const start = tr.startState
  const doc = tr.newDoc
  const caret = caretOf(tr.newSelection)
  const changes: { from: number; to: number; insert: string }[] = []
  /** The caret's line start in `doc`, and where it goes in the printed line. */
  let placed: { from: number; column: number } | null = null
  const composed = start.field(composedTables, false) ?? null
  for (const table of composed ?? tablesTouched(writeTablesOf(start), tr.changes)) {
    const edits = editsCells(tr.changes, table)
    if (composed ? edits === 'other' : !shownTable(start, table) || edits !== 'cells') continue
    if (table.lines.some((line) => line.extra)) continue
    const lines = table.lines.map((line) => ({
      prefix: line.prefix,
      from: tr.changes.mapPos(line.from, -1),
      to: tr.changes.mapPos(line.to, 1),
      cells: line.cells.map((c) => ({
        from: tr.changes.mapPos(c.from, -1),
        to: tr.changes.mapPos(c.to, 1),
      })),
    }))
    let at: { line: number; cell: number; offset: number } | undefined
    const texts = lines.map((line, i) =>
      line.cells.map((cell, c) => {
        const inCell = caret !== null && caret >= cell.from && caret <= cell.to
        const edit = cellEdit(
          doc.sliceString(cell.from, cell.to),
          inCell ? caret - cell.from : null,
        )
        if (inCell) at = { line: i, cell: c, offset: edit.offset }
        return edit.text
      }),
    )
    const columns = table.align.length
    const pad = (cells: string[]) => [...cells, ...Array<string>(columns - cells.length).fill('')]
    const printed = printTable({
      header: pad(texts[0]!),
      align: table.align,
      rows: texts.slice(DELIMITER + 1).map(pad),
    })
    for (const [i, line] of lines.entries()) {
      const text = line.prefix + printed.lines[i]!
      const old = doc.sliceString(line.from, line.to)
      if (text === old) continue
      const diff = textDiff(old, text)
      const from = line.from + diff.index
      changes.push({ from, to: from + diff.remove, insert: diff.insert })
    }
    if (at) {
      const line = lines[at.line]!
      const span = printed.cells[at.line]![at.cell]!
      placed = { from: line.from, column: line.prefix.length + span.from + at.offset }
    }
  }
  if (changes.length === 0 && !placed) return null
  const set = ChangeSet.of(changes as ChangeSpec, doc.length)
  const spec: TransactionSpec = { changes: set, sequential: true }
  if (placed) {
    const head = set.mapPos(placed.from, -1) + placed.column
    if (changes.length === 0 && head === caret) return null
    spec.selection = EditorSelection.cursor(head)
  }
  return spec
}
