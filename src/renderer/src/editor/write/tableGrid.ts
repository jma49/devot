// Write mode draws a table as a grid and the caret edits its cells in place.
// The source stays in the editor: each row is its line laid out as a grid,
// each cell a span around the text between its pipes, and the pipes, padding
// and delimiter row are hidden. Typing, input methods, undo and the toolbar
// are the editor's own; a filter keeps the pipes and line breaks out of a
// cell edit and prints the table again in the same transaction.
import {
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type Command,
} from '@codemirror/view'
import { displayWidth } from '../table'
import { tableCommand } from '../tableCommands'
import { tableRowTypingOff } from '../tableTyping'
import { writeBlockRule, type BlockLayers, type BlockRule } from './blocks'
import {
  DELIMITER,
  atomicSpans,
  cellBoxes,
  caretInCell,
  caretOf,
  hiddenSpans,
  shownTable,
  structureSpans,
  visibleSpan,
  writeTablesOf,
  formatAfter,
  type WriteTable,
} from './tables'

// Gives an empty cell a line's height and the caret a place to be drawn.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b)

class BlankCell extends WidgetType {
  override eq(): boolean {
    return true
  }

  override toDOM(): HTMLElement {
    const blank = document.createElement('span')
    blank.className = 'cm-wm-cell-blank'
    blank.textContent = ZERO_WIDTH_SPACE
    return blank
  }

  override ignoreEvent(): boolean {
    return false
  }
}

const blank = Decoration.widget({ widget: new BlankCell(), side: 1 })
const hidden = Decoration.replace({})
const atom = Decoration.mark({})

const MIN_COLUMN = 3
const MAX_COLUMN = 48
// Marks a cell's width does not count: emphasis, code and the parts of a link but its text.
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const MARKS = /\*\*|__|~~|==|[*`]|\\(?=[^\s])/g

/** About how many characters wide a cell's text shows, its marks left out. */
export function shownWidth(source: string): number {
  return displayWidth(source.replace(LINK, '$1').replace(MARKS, ''))
}

// Column widths go in a stylesheet of their own, one rule per set of widths:
// the page's content security policy refuses style attributes.
const columnClasses = new Map<string, string>()
let columnSheet: CSSStyleSheet | null | undefined
let serial = 0
const MAX_RULES = 512

function sheet(): CSSStyleSheet | null {
  if (columnSheet === undefined) {
    try {
      columnSheet = new CSSStyleSheet()
    } catch {
      columnSheet = null
    }
  }
  return columnSheet
}

function columnsClass(widths: readonly number[]): string {
  const key = widths.join(',')
  const known = columnClasses.get(key)
  if (known) return known
  const rules = sheet()
  if (columnClasses.size >= MAX_RULES) {
    columnClasses.clear()
    rules?.replaceSync('')
  }
  const name = `cm-wm-cols-${serial++}`
  columnClasses.set(key, name)
  const tracks = widths.map((w) => `minmax(0, calc(${w}ch + 2 * var(--space-5) + 1px))`)
  rules?.insertRule(`.${name} { grid-template-columns: ${tracks.join(' ')}; }`)
  return name
}

const adoptColumns = ViewPlugin.define((view) => {
  const rules = sheet()
  const root = view.root as Document | ShadowRoot
  if (rules && root.adoptedStyleSheets && !root.adoptedStyleSheets.includes(rules))
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, rules]
  return {}
})

function widthsOf(state: EditorState, table: WriteTable): number[] {
  return table.align.map((_, column) => {
    let width = MIN_COLUMN
    for (const [i, line] of table.lines.entries()) {
      const cell = line.cells[column]
      if (i === DELIMITER || !cell) continue
      width = Math.max(width, shownWidth(state.doc.sliceString(cell.textFrom, cell.textTo)))
    }
    return Math.min(width, MAX_COLUMN)
  })
}

function grid(state: EditorState, table: WriteTable, layers: BlockLayers): void {
  const caret = caretOf(state.selection)
  const columns = columnsClass(widthsOf(state, table))
  const decorations = layers.decorations as Range<Decoration>[]
  const outer = layers.outer as Range<Decoration>[]
  const atomic = layers.atomic as Range<Decoration>[]
  const rows = cellBoxes(table)
  rows.forEach(({ line, boxes }, r) => {
    const look = [
      'cm-wm-row',
      columns,
      r === 0 ? 'cm-wm-row-head' : r % 2 === 0 ? 'cm-wm-row-even' : '',
      r === rows.length - 1 ? 'cm-wm-row-last' : '',
    ]
    decorations.push(Decoration.line({ class: look.filter(Boolean).join(' ') }).range(line.from))
    boxes.forEach(([from, to], c) => {
      const align = table.align[c] ?? 'none'
      const cls = `cm-wm-cell cm-wm-align-${align}${c === 0 ? ' cm-wm-cell-first' : ''}`
      outer.push(Decoration.mark({ class: cls, inclusive: true }).range(from, to))
      const [shownFrom, shownTo] = visibleSpan(line.cells[c]!, caret)
      if (shownFrom === shownTo) decorations.push(blank.range(shownFrom))
    })
  })
  for (const [from, to] of hiddenSpans(table, caret)) decorations.push(hidden.range(from, to))
  for (const [from, to] of atomicSpans(table, caret, state.doc.length))
    atomic.push(atom.range(from, to))
}

/** Every table at the top level of the note as a grid, but one with several cursors in it. */
export const tableRule: BlockRule = (state) => {
  const layers: BlockLayers = { decorations: [], outer: [], atomic: [] }
  for (const table of writeTablesOf(state)) if (shownTable(state, table)) grid(state, table, layers)
  return layers
}

/**
 * The user's edits that may go into a cell: typing, pasting, dropping,
 * deleting and formatting; none inside a composition.
 */
function userEdit(tr: Transaction): boolean {
  if (tr.isUserEvent('input.type.compose')) return false
  return tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move.drop')
}

/** A user's edit takes no pipe or line break of a shown table, unless it takes all of the table. */
// Formatting and the table commands edit the structure on purpose.
const keepStructure = EditorState.changeFilter.of((tr) => {
  if (!userEdit(tr) || tr.isUserEvent('input.format')) return true
  const start = tr.startState
  const kept: number[] = []
  for (const table of writeTablesOf(start)) {
    if (!shownTable(start, table)) continue
    let touched = false
    let whole = false
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= table.to + 1 && toA >= table.from - 1) touched = true
      if (fromA <= table.from && toA >= table.to) whole = true
    })
    if (!touched || whole) continue
    for (const [from, to] of structureSpans(table, start.doc.length)) kept.push(from, to)
  }
  return kept.length === 0 ? true : kept
})

const formatCells = EditorState.transactionFilter.of((tr) => {
  if (userEdit(tr) && tr.docChanged) {
    const format = formatAfter(tr)
    return format ? [tr, format] : tr
  }
  if (tr.docChanged || !tr.selection) return tr
  // A caret moved onto a table's pipes or delimiter row (Home, End, the
  // note's start, a Backspace kept from the line break under the table)
  // goes into the nearest cell.
  const caret = caretOf(tr.newSelection)
  if (caret === null) return tr
  for (const table of writeTablesOf(tr.state)) {
    if (table.from > caret) break
    if (!shownTable(tr.state, table)) continue
    const target = caretInCell(table, caret)
    if (target !== null && target !== caret)
      return [tr, { selection: EditorSelection.cursor(target), sequential: true }]
  }
  return tr
})

const nextRow = tableCommand('nextRow', true)

/** Return in a grid's first cell goes to the next row too: there is no place before the row's pipe. */
const gridReturn: Command = (view) => {
  const caret = caretOf(view.state.selection)
  if (caret === null) return false
  const table = writeTablesOf(view.state).find((t) => t.from <= caret && caret <= t.to)
  return table !== undefined && shownTable(view.state, table) && nextRow(view)
}

export const writeTables: Extension = [
  writeBlockRule.of(tableRule),
  keepStructure,
  formatCells,
  tableRowTypingOff.of(true),
  adoptColumns,
  Prec.highest(keymap.of([{ key: 'Enter', run: gridReturn }])),
]

const token = (name: string) => `var(--color-${name})`
const HAIRLINE = `1px solid ${token('line-hairline')}`

export const tableTheme = EditorView.theme({
  '&[data-write] .cm-line.cm-wm-row': {
    display: 'grid',
    justifyContent: 'start',
    paddingInline: 'var(--space-3)',
  },
  '&[data-write] .cm-line.cm-wm-row::before': { display: 'none' },
  '.cm-wm-cell': {
    display: 'block',
    minWidth: '0',
    padding: 'var(--space-2) var(--space-5)',
    borderInlineEnd: HAIRLINE,
    borderBottom: HAIRLINE,
    overflowWrap: 'anywhere',
  },
  '.cm-wm-cell-first': { borderInlineStart: HAIRLINE },
  '.cm-wm-row-head .cm-wm-cell': {
    borderTop: HAIRLINE,
    backgroundColor: token('table-head'),
    fontWeight: 'var(--font-weight-semibold)',
  },
  // The header's text is the table's, not a heading's.
  '.cm-wm-row-head .cm-md-table-header > span': { color: 'inherit' },
  '.cm-wm-row-even .cm-wm-cell': { backgroundColor: token('table-stripe') },
  '.cm-wm-align-center': { textAlign: 'center' },
  '.cm-wm-align-right': { textAlign: 'end' },
})
