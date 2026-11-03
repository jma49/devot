// Counts the words and characters of the note, and of the selection, once typing and moving have
// paused (the editor footer shows them). A note is counted at most once per pause, never per keystroke.
import { StateEffect, type EditorState, type Extension } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { noteCounts, type NoteCounts } from '../../../core/noteCounts'

export const COUNTS_DEBOUNCE_MS = 300

export interface EditorCounts extends NoteCounts {
  /** Counts of the selected text; null with a caret only. */
  readonly selection: NoteCounts | null
}

export class CountsPacer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private whole: NoteCounts | undefined
  private stopped = false

  constructor(
    private readonly current: () => EditorState,
    private readonly report: (counts: EditorCounts) => void,
    private readonly wanted: () => boolean = () => true,
  ) {
    this.schedule(0)
  }

  changed(text: boolean) {
    if (text) this.whole = undefined
    this.schedule(COUNTS_DEBOUNCE_MS)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private schedule(wait: number) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.measure(), wait)
  }

  private measure() {
    if (!this.wanted()) return
    const state = this.current()
    this.whole ??= noteCounts(state.doc.toString())
    const picked = state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => state.sliceDoc(r.from, r.to))
    this.report({
      ...this.whole,
      selection: picked.length > 0 ? noteCounts(picked.join('\n')) : null,
    })
  }
}

/** Asks for counts again, for when the footer is shown after the text last changed. */
export const recount = StateEffect.define<null>()

/** Reports only while `wanted()` holds. */
export function countsReporter(
  report: (counts: EditorCounts) => void,
  wanted: () => boolean,
): Extension {
  return ViewPlugin.define((view) => {
    const pacer = new CountsPacer(() => view.state, report, wanted)
    return {
      update: (update) => {
        const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(recount)))
        if (update.docChanged || update.selectionSet || asked) pacer.changed(update.docChanged)
      },
      destroy: () => pacer.stop(),
    }
  })
}
