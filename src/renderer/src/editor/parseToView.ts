import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { Tree } from '@lezer/common'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

// CodeMirror's own parse worker reaches a jump target in 100 ms slices with pauses of 100 to 500 ms
// between them, keys waiting behind each slice. Short slices close together bring the parse there in
// little more than the time the parse itself takes, keys going between them.
const SLICE_MS = 8
// As far past the view as CodeMirror's worker parses, so it then finds nothing left to do.
const PARSE_AHEAD = 100_000
// A change ends the parse under way, and the next starts over from what that one had, which costs
// more the longer the note: slices between keys that come this close would only add that to each key.
const QUIET_MS = 100

class ParseToView {
  private timer: ReturnType<typeof setTimeout> | null = null
  private changedAt = 0

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (update.docChanged) this.changedAt = performance.now()
    if (this.timer !== null || !(update.viewportChanged || update.docChanged)) return
    if (!syntaxTreeAvailable(update.state, update.view.viewport.to)) this.next()
  }

  private next(delay = 0): void {
    this.timer ??= setTimeout(() => this.step(), delay)
  }

  private step(): void {
    this.timer = null
    const quiet = this.changedAt + QUIET_MS - performance.now()
    if (quiet > 0) {
      this.next(quiet)
      return
    }
    const { state, viewport } = this.view
    if (!syntaxTreeAvailable(state, viewport.to)) {
      this.publish(ensureSyntaxTree(state, viewport.to, SLICE_MS))
      this.next()
      return
    }
    const ahead = ensureSyntaxTree(state, viewport.to + PARSE_AHEAD, SLICE_MS)
    if (ahead) this.publish(ahead)
    else this.next()
  }

  /** Hands a finished parse to the state, as CodeMirror's `forceParsing` does. */
  private publish(tree: Tree | null): void {
    if (tree && tree !== syntaxTree(this.view.state)) this.view.dispatch({})
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer)
  }
}

/** Parses toward a part of the note the view jumped to before the parser reached it. */
export const parseToView = ViewPlugin.fromClass(ParseToView)
