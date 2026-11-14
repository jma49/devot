// Counts the words and characters of the note, and of the selection, once typing and moving have
// paused (the editor footer shows them). A note is counted at most once per pause, never per keystroke,
// and the editor has the core worker count it: a long note takes longer than a frame to count. Note Info
// shares that count (noteTally.ts).
import { StateEffect, type EditorState, type Extension } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { noteCounts, type NoteCounts } from '../../../core/noteCounts'
import { wordGoal } from '../../../core/wordGoal'

export const COUNTS_DEBOUNCE_MS = 300

export interface EditorCounts extends NoteCounts {
  /** Counts of the selected text; null with a caret only. */
  readonly selection: NoteCounts | null
  /** The note's `word-goal` front matter, when it has one. */
  readonly goal?: number
}

/** Front matter longer than this has no goal, so a pause never copies a long note to look for one. */
const GOAL_HEAD_CHARS = 16_384

/** Counts `markdown` as `noteCounts` does, perhaps elsewhere. */
export type Counter = (markdown: string) => NoteCounts | Promise<NoteCounts>

const then = <T, U>(value: T | Promise<T>, next: (value: T) => U): U | Promise<U> =>
  value instanceof Promise ? value.then(next) : next(value)

export class CountsPacer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private whole: NoteCounts | Promise<NoteCounts> | undefined
  private stopped = false
  private measured = 0

  constructor(
    private readonly current: () => EditorState,
    private readonly report: (counts: EditorCounts) => void,
    private readonly wanted: () => boolean = () => true,
    private readonly count: Counter = (markdown) => noteCounts(markdown),
    private readonly countNote: Counter = count,
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
    const run = ++this.measured
    const whole = (this.whole ??= this.countNote(state.doc.toString()))
    const picked = state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => state.sliceDoc(r.from, r.to))
    const selection = picked.length > 0 ? this.count(picked.join('\n')) : null
    const goal = wordGoal(state.sliceDoc(0, GOAL_HEAD_CHARS))
    const counted = then(whole, (note) =>
      then(selection, (part) => {
        if (run === this.measured && !this.stopped) {
          const counts = { words: note.words, characters: note.characters, selection: part }
          this.report(goal === null ? counts : { ...counts, goal })
        }
      }),
    )
    if (counted instanceof Promise)
      counted.catch(() => {
        if (this.whole === whole) this.whole = undefined
        console.warn('W_COUNTS_FAILED')
      })
  }
}

/** Asks for counts again, for when the footer is shown after the text last changed. */
export const recount = StateEffect.define<null>()

/** Reports only while `wanted()` holds; `countNote` counts the whole note, `count` the selection. */
export function countsReporter(
  report: (counts: EditorCounts) => void,
  wanted: () => boolean,
  count?: Counter,
  countNote?: Counter,
): Extension {
  return ViewPlugin.define((view) => {
    const pacer = new CountsPacer(() => view.state, report, wanted, count, countNote)
    return {
      update: (update) => {
        const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(recount)))
        if (update.docChanged || update.selectionSet || asked) pacer.changed(update.docChanged)
      },
      destroy: () => pacer.stop(),
    }
  })
}
