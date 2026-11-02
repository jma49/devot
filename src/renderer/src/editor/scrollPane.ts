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

export function editorScrollPane(view: EditorView, scroller: HTMLElement): ScrollPane {
  const visibleTop = () =>
    scroller.getBoundingClientRect().top + scroller.clientTop - view.documentTop

  return {
    element: scroller,
    topLine() {
      const height = visibleTop()
      const block = view.lineBlockAtHeight(Math.max(0, height))
      const line = view.state.doc.lineAt(block.from).number
      const into = block.height > 0 ? (height - block.top) / block.height : 0
      return line + Math.min(1, Math.max(0, into))
    },
    offsetOf(line) {
      const doc = view.state.doc
      const number = Math.min(doc.lines, Math.max(1, Math.floor(line)))
      const block = view.lineBlockAt(doc.line(number).from)
      const into = Math.min(1, Math.max(0, line - number))
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
