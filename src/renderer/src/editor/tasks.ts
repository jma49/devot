// Ticking a task in the preview changes the note: the mark between the
// brackets of `- [ ]` at the offset the preview gives (`data-task-at`).
import type { EditorState, TransactionSpec } from '@codemirror/state'

/**
 * The change that ticks or unticks the task whose mark is at `at`, or null
 * when the text there is no longer a task's box or the note is read-only.
 */
export function taskToggle(state: EditorState, at: number): TransactionSpec | null {
  if (state.readOnly || !Number.isInteger(at) || at < 1 || at + 2 > state.doc.length) return null
  const box = state.doc.sliceString(at - 1, at + 2)
  if (!/^\[[ xX]\]$/.test(box)) return null
  return {
    changes: { from: at, to: at + 1, insert: box[1] === ' ' ? 'x' : ' ' },
    userEvent: 'input.task',
  }
}
