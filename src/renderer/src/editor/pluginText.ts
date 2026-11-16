import type { EditorState, TransactionSpec } from '@codemirror/state'
import { MAX_BODY_BYTES } from '../../../core/noteLimits'
import { lineFeeds, utf8Length } from '../../../core/text'

export function pluginSelection(state: EditorState) {
  const { from, to } = state.selection.main
  return { from, to, text: state.sliceDoc(from, to) }
}

/** The change a plugin's `note.insert` makes, or the code it is refused with. */
export function pluginInsert(
  state: EditorState,
  given: string,
  selected: string | null,
): TransactionSpec | { code: string } {
  const text = lineFeeds(given)
  const { from, to } = state.selection.main
  const replaced = state.sliceDoc(from, to)
  if (selected !== null && replaced !== selected) return { code: 'E_PLUGIN_NOTE_CHANGED' }
  const bytes = utf8Length(state.doc.toString()) - utf8Length(replaced) + utf8Length(text)
  if (bytes > MAX_BODY_BYTES) return { code: 'E_NOTE_BODY_TOO_LARGE' }
  return {
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
    userEvent: 'input.plugin',
  }
}
