// The keys an input method uses (`isImeKey`, ../ime.ts) reach none of the
// editor's keymaps: the Return that picks a candidate would also start a
// new line or list item (or pick from an open list), the Escape that cancels
// a composition would also close the find bar.
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { isImeKey } from '../ime'

/**
 * Keys typed into a composition: stopped on their way to the editor, never
 * prevented, so that the keys the input method passes on (Command-Q,
 * Command-V) still reach the menu bar. CodeMirror leaves keys alone while it
 * composes too; this also covers the moment before a composition changes
 * any text.
 */
const typedIntoComposition = ViewPlugin.define((view) => {
  const stop = (event: KeyboardEvent) => {
    if (event.isComposing) event.stopPropagation()
  }
  view.dom.addEventListener('keydown', stop, true)
  return { destroy: () => view.dom.removeEventListener('keydown', stop, true) }
})

/**
 * The key that ended a composition (key code 229, after compositionend):
 * CodeMirror ignores it only for a moment after the composition ended, so it
 * stops here, ahead of every keymap, once CodeMirror has seen it.
 */
const endingComposition = Prec.highest(
  EditorView.domEventHandlers({ keydown: (event) => isImeKey(event) }),
)

/** Keeps an input method's keys away from the editor's keymaps. */
export function imeKeys(): Extension {
  return [typedIntoComposition, endingComposition]
}
