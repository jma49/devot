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
  StateField,
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
  type ViewUpdate,
} from '@codemirror/view'
import { displayWidth } from '../table'
import { spec } from '../formatContext'
import { locate, rewrite, tableCommand } from '../tableCommands'
import { tableRowTypingOff } from '../tableTyping'
import { writeBlockRule, type BlockLayers, type BlockPiece, type BlockRule } from './blocks'
import { firstReaching } from './changes'
import {
  DELIMITER,
  atomicSpans,
  cellBoxes,
  caretInCell,
  caretOf,
  cellTints,
  crossingRanges,
  reachesRowEnd,
  hiddenSpans,
  shownTable,
  structureSpans,
  visibleSpan,
  writeTablesOf,
  tablesTouched,
  carryWriteTables,
  formatAfter,
  composedTables,
  type Span,
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
// An empty cell with nothing between its pipes: its point is its box's end.
const blankAtEnd = Decoration.widget({ widget: new BlankCell(), side: -1 })

/** Pads the row at `pos` out to the table's columns and puts the caret in `column`. */
function fillRow(view: EditorView, pos: number, column: number) {
  const line = view.state.doc.lineAt(pos)
  const at = locate(view.state.update({ selection: { anchor: line.to } }).state)
  if (!at) return
  const { change, cursor } = rewrite(view.state, at, {
    table: at.table,
    line: at.line,
    column,
    offset: 0,
  })
  const selection = EditorSelection.single(cursor)
  view.dispatch(change ? spec(change, selection) : { selection, userEvent: 'select' })
  view.focus()
}

/** A cell a short row leaves out, which GFM reads as empty: a click writes it. */
class MissingCell extends WidgetType {
  constructor(
    readonly column: number,
    readonly className: string,
  ) {
    super()
  }

  override eq(other: MissingCell): boolean {
    return other.column === this.column && other.className === this.className
  }

  override toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement('span')
    cell.className = this.className
    cell.textContent = ZERO_WIDTH_SPACE
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      fillRow(view, view.posAtDOM(cell), this.column)
    })
    return cell
  }

  override ignoreEvent(): boolean {
    return true
  }
}
const hidden = Decoration.replace({})
const atom = Decoration.mark({})

const MIN_COLUMN = 3
const MAX_COLUMN = 48
// A column's track takes its cell's hairlines (the first cell has one more) and a pixel for the text's rounding.
const EDGES = 2
// Marks a cell's width does not count: emphasis, code and the parts of a link but its text.
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const MARKS = /\*\*|__|~~|==|[*`]|\\(?=[^\s])/g

/** About how many characters wide a cell's text shows, its marks left out. */
export function shownWidth(source: string): number {
  return displayWidth(source.replace(LINK, '$1').replace(MARKS, ''))
}

// Column widths go in a stylesheet of their own, one rule per set of widths:
// the page's content security policy refuses style attributes.
const columnRules = new Map<string, { name: string; rule: CSSRule }>()
let columnSheet: CSSStyleSheet | null | undefined
let serial = 0

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

// Returned only while its rule is in the column sheet.
function columnsClass(widths: readonly number[]): string | null {
  const rules = sheet()
  if (!rules) return null
  const key = widths.join(',')
  const known = columnRules.get(key)
  if (known && known.rule.parentStyleSheet === rules) return known.name
  const name = `cm-wm-cols-${serial++}`
  const tracks = widths.map(
    (w, c) => `minmax(0, calc(${w}ch + 2 * var(--space-5) + ${EDGES + (c === 0 ? 1 : 0)}px))`,
  )
  try {
    const at = rules.insertRule(
      `.${name} { grid-template-columns: ${tracks.join(' ')}; }`,
      rules.cssRules.length,
    )
    columnRules.set(key, { name, rule: rules.cssRules[at]! })
  } catch {
    return null
  }
  return name
}

type StyledRoot = { adoptedStyleSheets: CSSStyleSheet[] }

/**
 * Keeps a growing stylesheet in effect in a root. The sheet is adopted again
 * whenever the root's list lost it (another script replaced the list), the
 * root changed, or the sheet gained rules since: adopting a list anew restyles
 * the root, where a rule added to an adopted sheet may not (issue 560).
 */
export class SheetAdoption {
  private root: StyledRoot | null = null
  private rules = -1

  constructor(private readonly adopted: CSSStyleSheet) {}

  ensure(root: StyledRoot): void {
    const list = root.adoptedStyleSheets
    const rules = this.adopted.cssRules.length
    if (root === this.root && rules === this.rules && list.includes(this.adopted)) return
    root.adoptedStyleSheets = [...list.filter((s) => s !== this.adopted), this.adopted]
    this.root = root
    this.rules = rules
  }
}

const adoptColumns = ViewPlugin.fromClass(
  class {
    private readonly adoption: SheetAdoption | null

    constructor(private readonly view: EditorView) {
      const rules = sheet()
      this.adoption = rules ? new SheetAdoption(rules) : null
      this.ensure()
    }

    update() {
      this.ensure()
    }

    private ensure() {
      const root = this.view.root as Partial<StyledRoot>
      if (this.adoption && root.adoptedStyleSheets) this.adoption.ensure(root as StyledRoot)
    }
  },
)

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
  const tints = cellTints(table, state.selection)
  rows.forEach(({ line, boxes }, r) => {
    const look = [
      'cm-wm-row',
      columns ?? '',
      r === 0 ? 'cm-wm-row-head' : r % 2 === 0 ? 'cm-wm-row-even' : '',
      r === rows.length - 1 ? 'cm-wm-row-last' : '',
    ]
    decorations.push(Decoration.line({ class: look.filter(Boolean).join(' ') }).range(line.from))
    const rowTints = tints[r]!
    const cellClass = (c: number, tint = rowTints[c]) =>
      [
        'cm-wm-cell',
        `cm-wm-align-${table.align[c] ?? 'none'}`,
        c === 0 ? 'cm-wm-cell-first' : '',
        tint ? `cm-wm-cell-${tint}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    const short = line.cells.length < table.align.length
    boxes.forEach(([from, to], c) => {
      // A short row's missing cells come after its last box.
      const inclusiveEnd = !short || c < boxes.length - 1
      const box = Decoration.mark({ class: cellClass(c), inclusiveStart: true, inclusiveEnd })
      outer.push(box.range(from, to))
      const cell = line.cells[c]!
      const [shownFrom, shownTo] = visibleSpan(cell, caret)
      if (shownFrom === shownTo)
        decorations.push((cell.to === cell.from ? blankAtEnd : blank).range(shownFrom))
    })
    const missingTint = reachesRowEnd(table, line, state.selection) ? 'selected' : null
    for (let c = line.cells.length; c < table.align.length; c++) {
      const widget = new MissingCell(c, `${cellClass(c, missingTint)} cm-wm-cell-missing`)
      decorations.push(Decoration.widget({ widget, side: 1 + c }).range(line.to))
    }
  })
  for (const [from, to] of hiddenSpans(table, caret)) decorations.push(hidden.range(from, to))
  for (const [from, to] of atomicSpans(table, caret, state.doc.length))
    atomic.push(atom.range(from, to))
}

interface Placed {
  value: Decoration
  from: number
  to: number
}

type Drawing = Record<keyof BlockLayers, Placed[]>

// A table no selection range meets draws the same wherever it is, so the
// drawing is kept by its shape and text, relative to its start: a keystroke or
// a caret move elsewhere draws no table again. The drawings go with the note's
// editor states, so a note left lets go of its tables. Cleared when they grow past this.
const tableDrawings = StateField.define<Map<string, Drawing>>({
  create: () => new Map(),
  update: (drawings) => drawings,
})
const DRAWINGS_KEPT = 1000
// The same table (one note text and tree) is placed once: a caret move places no table again.
const placed = new WeakMap<WriteTable, BlockLayers>()

const untouched = (state: EditorState, table: WriteTable) =>
  state.selection.ranges.every((r) => r.to < table.from || r.from > table.to)

function drawingKey(state: EditorState, table: WriteTable): string {
  const at = table.from
  const shape = table.lines.map((line) => {
    const cells = line.cells.map(
      (c) => `${c.from - at} ${c.to - at} ${c.textFrom - at} ${c.textTo - at}`,
    )
    return `${line.from - at} ${line.to - at} ${line.extra ? 1 : 0} ${line.prefix.length} ${cells.join(' ')}`
  })
  // The caret's span around a table stops at the note's edges.
  const edges = `${at === 0 ? 1 : 0}${table.to >= state.doc.length ? 1 : 0}`
  return `${edges}|${table.align.join(' ')}|${shape.join('|')}|${state.doc.sliceString(at, table.to)}`
}

function drawn(state: EditorState, table: WriteTable): Drawing {
  const layers: BlockLayers = { decorations: [], outer: [], atomic: [] }
  grid(state, table, layers)
  const relative = (ranges: readonly Range<Decoration>[]) =>
    ranges.map((r) => ({ value: r.value, from: r.from - table.from, to: r.to - table.from }))
  return {
    decorations: relative(layers.decorations),
    outer: relative(layers.outer),
    atomic: relative(layers.atomic),
  }
}

function placedOf(state: EditorState, table: WriteTable): BlockLayers {
  if (!untouched(state, table)) {
    const layers: BlockLayers = { decorations: [], outer: [], atomic: [] }
    grid(state, table, layers)
    return layers
  }
  const known = placed.get(table)
  if (known) return known
  const drawings = state.field(tableDrawings)
  const key = drawingKey(state, table)
  let drawing = drawings.get(key)
  if (!drawing) {
    if (drawings.size >= DRAWINGS_KEPT) drawings.clear()
    drawing = drawn(state, table)
    drawings.set(key, drawing)
  }
  const place = (from: readonly Placed[]) =>
    from.map((p) => p.value.range(table.from + p.from, table.from + p.to))
  const layers = {
    decorations: place(drawing.decorations),
    outer: place(drawing.outer),
    atomic: place(drawing.atomic),
  }
  placed.set(table, layers)
  return layers
}

/** Every table of the note as a grid, but one with several cursors in it; a piece takes the line breaks around it. */
export const tableRule: BlockRule = {
  pieces(state, _revealed, from, to) {
    const tables = writeTablesOf(state)
    const length = state.doc.length
    const out: BlockPiece[] = []
    for (let i = firstReaching(tables, from - 1); i < tables.length; i++) {
      const table = tables[i]!
      if (table.from - 1 > to) break
      if (!shownTable(state, table)) continue
      const layers = placedOf(state, table)
      out.push({ from: Math.max(0, table.from - 1), to: Math.min(length, table.to + 1), layers })
    }
    return out
  },
  carry: carryWriteTables,
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
  for (const table of tablesTouched(writeTablesOf(start), tr.changes, 1)) {
    if (!shownTable(start, table)) continue
    let whole = false
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= table.from && toA >= table.to) whole = true
    })
    if (whole) continue
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
  const tables = writeTablesOf(tr.state)
  const table = tables[firstReaching(tables, caret)]
  if (!table || !shownTable(tr.state, table)) return tr
  const target = caretInCell(table, caret)
  if (target === null || target === caret) return tr
  return [tr, { selection: EditorSelection.cursor(target), sequential: true }]
})

const nextRow = tableCommand('nextRow', true)

/** Return in a grid's first cell goes to the next row too: there is no place before the row's pipe. */
const gridReturn: Command = (view) => {
  const caret = caretOf(view.state.selection)
  if (caret === null) return false
  const table = writeTablesOf(view.state).find((t) => t.from <= caret && caret <= t.to)
  return table !== undefined && shownTable(view.state, table) && nextRow(view)
}

const FAR = 1e6

/**
 * A line block's top (or bottom) in the selection layer's units. CodeMirror
 * places a selection's rectangles at client offsets from the scroll box's
 * content corner and scales the layer back by the view's scale.
 */
export function layerY(
  block: number,
  frame: { documentTop: number; scrollerTop: number; scrollTop: number; scaleY: number },
): number {
  return frame.documentTop - frame.scrollerTop + (block + frame.scrollTop) * frame.scaleY
}

/**
 * A clip path that leaves out the given bands (top, bottom) across the whole
 * width, in the selection layer's coordinates; empty for none.
 */
export function bandsClip(bands: readonly Span[]): string {
  if (bands.length === 0) return ''
  const rects: string[] = []
  let top = -FAR
  for (const [from, to] of [...bands].sort((a, b) => a[0] - b[0])) {
    if (from > top) rects.push(`M -${FAR} ${top} H ${FAR} V ${from} H -${FAR} Z`)
    top = Math.max(top, to)
  }
  rects.push(`M -${FAR} ${top} H ${FAR} V ${FAR} H -${FAR} Z`)
  return `path('${rects.join(' ')}')`
}

// CodeMirror draws a selection as rectangles over whole line boxes, and a
// grid's row is a line as wide as the column with its cells at the left, the
// table bar's room above the header in the first. Where a selection takes
// whole cells (the cells tint themselves), the selection layer leaves out the
// grid's lines, so nothing beside or above the grid is tinted.
const gridSelectionClip = ViewPlugin.fromClass(
  class {
    private readonly request: { read: () => string; write: (clip: string) => void }
    private clip = ''

    constructor(private readonly view: EditorView) {
      this.request = { read: () => this.read(), write: (clip) => this.write(clip) }
      view.requestMeasure(this.request)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.geometryChanged
      )
        this.view.requestMeasure(this.request)
    }

    private read(): string {
      const { view } = this
      const { state } = view
      const bands: Span[] = []
      if (state.selection.ranges.every((r) => r.empty)) return ''
      for (const table of writeTablesOf(state)) {
        if (!shownTable(state, table) || crossingRanges(table, state.selection).length === 0)
          continue
        bands.push([view.lineBlockAt(table.from).top, view.lineBlockAt(table.to).bottom])
      }
      if (bands.length === 0) return ''
      const frame = {
        documentTop: view.documentTop,
        scrollerTop: view.scrollDOM.getBoundingClientRect().top,
        scrollTop: view.scrollDOM.scrollTop,
        scaleY: view.scaleY,
      }
      return bandsClip(bands.map(([a, b]): Span => [layerY(a, frame), layerY(b, frame)]))
    }

    private write(clip: string) {
      if (clip === this.clip) return
      this.clip = clip
      this.layer()?.style.setProperty('clip-path', clip)
    }

    private layer(): HTMLElement | null {
      return this.view.scrollDOM.querySelector(':scope > .cm-selectionLayer')
    }

    destroy() {
      this.layer()?.style.removeProperty('clip-path')
    }
  },
)

export const writeTables: Extension = [
  composedTables,
  tableDrawings,
  writeBlockRule.of(tableRule),
  keepStructure,
  formatCells,
  tableRowTypingOff.of(true),
  adoptColumns,
  gridSelectionClip,
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
  // The caret's cell carries the active line, not its row (see the cell rules below).
  '&[data-write] .cm-line.cm-wm-row.cm-activeLine': { backgroundColor: 'transparent' },
  // Room for the table bar above the header, so it never covers the block above.
  '&[data-write] .cm-line.cm-wm-row.cm-md-table-first': {
    paddingTop: 'calc(var(--size-float-toolbar-height) + var(--size-float-notch-height))',
  },
  // Out of the grid's cells: CodeMirror puts these beside widgets for the caret.
  '&[data-write] .cm-line.cm-wm-row > .cm-widgetBuffer': { position: 'absolute' },
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
  // Over the cell's own fill, as a code box carries it (editor/codeBlocks.ts); only while the
  // editor has the keyboard and draws the active line.
  '&.cm-focused .cm-activeLine .cm-wm-cell-caret': {
    backgroundImage: `linear-gradient(${token('editor-active-line')}, ${token('editor-active-line')})`,
  },
  // A selection lies under the lines, so a selected cell is the selection's tint under its own fill.
  '.cm-wm-cell.cm-wm-cell-selected': { backgroundColor: token('accent-selection-inactive') },
  '&.cm-focused .cm-wm-cell.cm-wm-cell-selected': { backgroundColor: token('accent-selection') },
  '.cm-wm-row-head .cm-wm-cell.cm-wm-cell-selected': {
    backgroundImage: `linear-gradient(${token('table-head')}, ${token('table-head')})`,
  },
  '.cm-wm-row-even .cm-wm-cell.cm-wm-cell-selected': {
    backgroundImage: `linear-gradient(${token('table-stripe')}, ${token('table-stripe')})`,
  },
  '.cm-wm-align-center': { textAlign: 'center' },
  '.cm-wm-align-right': { textAlign: 'end' },
})
