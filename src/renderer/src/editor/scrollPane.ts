// The editor as a scroll pane for synced scrolling (preview/scrollSync.ts).
// Lines come from CodeMirror's height map, so finding a line costs no DOM
// reads beyond where the document and the scrolled element sit.
import { EditorView } from '@codemirror/view'
import type { ScrollPane } from '../preview/scrollSync'

const layoutListeners = new WeakMap<EditorView, Set<() => void>>()

// CodeMirror guesses the height of a line it has not drawn and learns the real
// one frames later, moving every line below it.
export const editorLayoutWatch = EditorView.updateListener.of((update) => {
  if (!update.heightChanged && !update.geometryChanged) return
  for (const listener of layoutListeners.get(update.view) ?? []) listener()
})

/**
 * A block of the height map can hold several lines (a rendered image, formula
 * or diagram in Write mode, a folded front matter): its height is shared out
 * evenly over them, so a line inside it still has a place.
 */
export function lineAtFraction(first: number, last: number, into: number): number {
  return first + Math.min(1, Math.max(0, into)) * (last - first + 1)
}

/** How far into a block of lines `first`..`last` line `line` (fractional) is, 0 to 1. */
export function fractionAtLine(first: number, last: number, line: number): number {
  return Math.min(1, Math.max(0, (line - first) / (last - first + 1)))
}

export function editorScrollPane(view: EditorView, scroller: HTMLElement): ScrollPane {
  const visibleTop = () =>
    scroller.getBoundingClientRect().top + scroller.clientTop - view.documentTop

  return {
    element: scroller,
    topLine() {
      const height = visibleTop()
      const block = view.lineBlockAtHeight(Math.max(0, height))
      const doc = view.state.doc
      const into = block.height > 0 ? (height - block.top) / block.height : 0
      return lineAtFraction(doc.lineAt(block.from).number, doc.lineAt(block.to).number, into)
    },
    offsetOf(line) {
      const doc = view.state.doc
      const number = Math.min(doc.lines, Math.max(1, Math.floor(line)))
      const block = view.lineBlockAt(doc.line(number).from)
      const first = doc.lineAt(block.from).number
      const last = doc.lineAt(block.to).number
      const into = fractionAtLine(first, last, Math.min(line, last + 1))
      return scroller.scrollTop + block.top + into * block.height - visibleTop()
    },
    onLayout(listener) {
      const listeners = layoutListeners.get(view) ?? new Set()
      layoutListeners.set(view, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
