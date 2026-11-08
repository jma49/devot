// A grid wider than the editor's column scrolls sideways. Each of its rows is
// a line of its own, so each row is its own scroll box and a scroll of one
// moves every row of the table with it, the rows drawn later included.
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import { firstReaching } from './changes'
import { shownTable, writeTablesOf, type WriteTable } from './tables'

interface Edges {
  left: number
  right: number
}

/**
 * The sideways scroll that shows the caret's cell whole in a row's box, or
 * the caret itself when the cell is wider than the box; `scroll` when it shows.
 */
export function revealScroll(cell: Edges, caret: number, box: Edges, scroll: number): number {
  const [from, to] =
    cell.right - cell.left <= box.right - box.left ? [cell.left, cell.right] : [caret, caret]
  if (from < box.left) return scroll - (box.left - from)
  if (to > box.right) return scroll + (to - box.right)
  return scroll
}

const ROW = 'cm-wm-row'
// Less than this is the same scroll: a scroll box may round what it is given.
const SAME = 0.5

function tableAt(state: EditorState, pos: number): WriteTable | null {
  const tables = writeTablesOf(state)
  const table = tables[firstReaching(tables, pos)]
  return table && table.from <= pos && shownTable(state, table) ? table : null
}

const within = (state: EditorState, table: WriteTable) =>
  state.selection.ranges.every((r) => r.from >= table.from && r.to <= table.to)

interface Reveal {
  table: WriteTable
  from: number
  to: number
}

// CodeMirror draws the caret and the selection in layers over the content,
// placed when they were last measured. While only a row's scroll moves what
// they were drawn over, they are moved with it; the next drawing places them anew.
const LAYERS = ['cm-cursorLayer', 'cm-selectionLayer'] as const

class TableScroll {
  // Each scrolled table's sideways scroll, by its start.
  private offsets = new Map<number, number>()
  private readonly shifts = [0, 0]
  private readonly redrawn = [false, false]
  private revealing = false
  private readonly measure = {
    key: this,
    read: () => this.read(),
    write: (reveal: Reveal | null) => this.write(reveal),
  }
  private readonly onScroll = (event: Event) => this.scrolled(event.target)

  constructor(private readonly view: EditorView) {
    view.contentDOM.addEventListener('scroll', this.onScroll, true)
  }

  update(update: ViewUpdate) {
    if (update.docChanged && this.offsets.size > 0) {
      const mapped = new Map<number, number>()
      for (const [from, x] of this.offsets) mapped.set(update.changes.mapPos(from), x)
      this.offsets = mapped
    }
    const reconfigured = update.transactions.some((tr) => tr.reconfigured)
    const cursor =
      update.docChanged || update.selectionSet || update.geometryChanged || reconfigured
    this.layersRedrawn(cursor, cursor || update.viewportChanged)
    if (
      (update.docChanged || update.selectionSet) &&
      !update.transactions.some((tr) => tr.isUserEvent('select.pointer'))
    ) {
      this.revealing = true
      this.view.requestMeasure(this.measure)
    }
  }

  docViewUpdate() {
    this.restore()
    this.layersRedrawn(true, true)
  }

  private layersRedrawn(cursor: boolean, selection: boolean) {
    if (!cursor && !selection) return
    if (cursor) this.redrawn[0] = true
    if (selection) this.redrawn[1] = true
    this.view.requestMeasure(this.measure)
  }

  private rows(table: WriteTable): HTMLElement[] {
    const rows: HTMLElement[] = []
    for (const line of this.view.contentDOM.children) {
      if (!(line instanceof HTMLElement) || !line.classList.contains(ROW)) continue
      const pos = this.view.posAtDOM(line)
      if (pos > table.to) break
      if (pos >= table.from) rows.push(line)
    }
    return rows
  }

  /** Gives the rows drawn since a table scrolled its scroll. */
  private restore() {
    if (this.offsets.size === 0) return
    const { state } = this.view
    for (const [from, x] of [...this.offsets]) {
      const table = tableAt(state, from)
      if (!table || table.from !== from) {
        this.offsets.delete(from)
        continue
      }
      for (const row of this.rows(table))
        if (Math.abs(row.scrollLeft - x) >= SAME) row.scrollLeft = x
    }
  }

  private scrolled(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || !target.classList.contains(ROW)) return
    const { state } = this.view
    const table = tableAt(state, this.view.posAtDOM(target))
    if (!table) return
    const x = target.scrollLeft
    const before = this.offsets.get(table.from) ?? 0
    if (Math.abs(x - before) < SAME) return
    this.keep(table, x)
    for (const row of this.rows(table)) if (Math.abs(row.scrollLeft - x) >= SAME) row.scrollLeft = x
    if (within(state, table)) this.shift(before - x)
  }

  private keep(table: WriteTable, x: number) {
    if (x < SAME) this.offsets.delete(table.from)
    else this.offsets.set(table.from, x)
  }

  private shift(by: number) {
    for (const i of [0, 1]) this.shifts[i]! += by
    this.place()
  }

  private place() {
    LAYERS.forEach((name, i) => {
      const layer = this.view.scrollDOM.querySelector<HTMLElement>(`:scope > .${name}`)
      const shift = this.shifts[i]!
      if (!layer) return
      if (Math.abs(shift) < SAME) layer.style.removeProperty('translate')
      else layer.style.setProperty('translate', `${shift}px 0`)
    })
  }

  private read(): Reveal | null {
    if (!this.revealing) return null
    this.revealing = false
    const { view } = this
    const { state } = view
    if (state.selection.ranges.length > 1) return null
    const head = state.selection.main.head
    const table = tableAt(state, head)
    if (!table) return null
    const { node, offset } = view.domAtPos(head)
    const at =
      node instanceof Element ? (node.childNodes[offset] ?? node.childNodes[offset - 1]) : node
    const el = at instanceof Element ? at : (at?.parentElement ?? null)
    const row = el?.closest<HTMLElement>(`.${ROW}`)
    const caret = view.coordsAtPos(head)
    if (!row || !caret) return null
    const box = row.getBoundingClientRect()
    const style = getComputedStyle(row)
    const left = box.left + row.clientLeft
    const edges = {
      left: left + parseFloat(style.paddingLeft),
      right: left + row.clientWidth - parseFloat(style.paddingRight),
    }
    const cell = el?.closest('.cm-wm-cell')?.getBoundingClientRect() ?? {
      left: caret.left,
      right: caret.left,
    }
    const from = row.scrollLeft
    return { table, from, to: revealScroll(cell, caret.left, edges, from) }
  }

  private write(reveal: Reveal | null) {
    this.redrawn.forEach((redrawn, i) => {
      if (redrawn) this.shifts[i] = 0
      this.redrawn[i] = false
    })
    if (reveal && Math.abs(reveal.to - reveal.from) >= SAME) {
      const rows = this.rows(reveal.table)
      for (const row of rows) row.scrollLeft = reveal.to
      const x = rows[0]?.scrollLeft ?? reveal.to
      this.keep(reveal.table, x)
      if (within(this.view.state, reveal.table))
        for (const i of [0, 1]) this.shifts[i]! += reveal.from - x
    }
    this.place()
  }

  destroy() {
    this.view.contentDOM.removeEventListener('scroll', this.onScroll, true)
    this.shifts.fill(0)
    this.place()
  }
}

export const tableScroll = ViewPlugin.fromClass(TableScroll)
