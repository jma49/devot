// CodeMirror draws a selection's first row from the caret and its last row to
// the text's end, and a full row only as wide as the content minus the first
// line's padding. A code block's box (and a table's, and a quote's bar) sits
// on the note's column, that shared padding. A line of a box adds its own
// padding inside, so when the first line is one of those the full rows stop
// short of the box. A plugin reaches every full side out to the column, so
// the tint wraps the box and a selection of whole lines reads as one block.
import { EditorSelection } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

export interface SelectionEdges {
  /** How far the first row reaches left to meet the box. */
  start: number
  /** How far the last row reaches right to meet the box. */
  end: number
  /** How far a side CodeMirror already drew at the fill still has to grow. */
  boxLeft: number
  boxRight: number
}

const none: SelectionEdges = { start: 0, end: 0, boxLeft: 0, boxRight: 0 }

/**
 * The reach of each end, given whether the selection is at a line's start (or
 * end), where the text starts (or ends), and the box's edges. Nothing reaches
 * past the box, and a caret (or a line that does not touch an edge) reaches
 * nowhere.
 */
export function edgeReach(
  atStart: boolean,
  atEnd: boolean,
  textStart: number | null,
  textEnd: number | null,
  boxLeft: number,
  boxRight: number,
): Pick<SelectionEdges, 'start' | 'end'> {
  return {
    start: atStart && textStart !== null ? Math.max(0, textStart - boxLeft) : 0,
    end: atEnd && textEnd !== null ? Math.max(0, boxRight - textEnd) : 0,
  }
}

/**
 * The column is `--box-edge` (every line's padding). CodeMirror's fill sits
 * inside a box by however much more padding the first line has.
 */
function frame(view: EditorView): (SelectionEdges & { edge: number }) | null {
  const line = view.contentDOM.querySelector('.cm-line')
  if (!line) return null
  const style = getComputedStyle(line)
  const padLeft = Number.parseFloat(style.paddingLeft)
  const padRight = Number.parseFloat(style.paddingRight)
  const edge = Number.parseFloat(getComputedStyle(view.contentDOM).getPropertyValue('--box-edge'))
  if (!Number.isFinite(padLeft) || !Number.isFinite(padRight) || !Number.isFinite(edge)) return null
  return {
    start: 0,
    end: 0,
    edge,
    boxLeft: Math.max(0, padLeft - edge),
    boxRight: Math.max(0, padRight - edge),
  }
}

export const selectionEdges = ViewPlugin.fromClass(
  class {
    private readonly request: {
      read: () => SelectionEdges
      write: (edges: SelectionEdges) => void
    }

    constructor(private readonly view: EditorView) {
      this.request = { read: () => this.read(), write: (edges) => this.write(edges) }
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

    private read(): SelectionEdges {
      const measured = frame(this.view)
      if (!measured) return none
      const { edge, ...edges } = measured
      const { main, ranges } = this.view.state.selection
      // Several selections interleave their rows: leaving those as CodeMirror draws them.
      if (ranges.length !== 1 || main.empty) return edges
      const content = this.view.contentDOM.getBoundingClientRect()
      // The start or end of the row the caret is in, wrapped or not.
      const rowStart = (pos: number) =>
        this.view.moveToLineBoundary(EditorSelection.cursor(pos), false, true).head === pos
      const rowEnd = (pos: number) =>
        this.view.moveToLineBoundary(EditorSelection.cursor(pos), true, true).head === pos
      const start = rowStart(main.from) ? this.view.coordsAtPos(main.from, 1) : null
      const end = rowEnd(main.to) ? this.view.coordsAtPos(main.to, -1) : null
      return {
        ...edgeReach(
          start !== null,
          end !== null,
          start?.left ?? null,
          end?.right ?? null,
          content.left + edge,
          content.right - edge,
        ),
        boxLeft: edges.boxLeft,
        boxRight: edges.boxRight,
      }
    }

    private write(edges: SelectionEdges) {
      const dom = this.view.dom
      dom.classList.toggle('cm-sel-reach-start', edges.start > 0.5)
      dom.classList.toggle('cm-sel-reach-end', edges.end > 0.5)
      dom.style.setProperty('--sel-reach-start', `${edges.start}px`)
      dom.style.setProperty('--sel-reach-end', `${edges.end}px`)
      dom.style.setProperty('--sel-box-left', `${edges.boxLeft}px`)
      dom.style.setProperty('--sel-box-right', `${edges.boxRight}px`)
    }
  },
)
