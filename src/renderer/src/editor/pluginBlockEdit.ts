// Loaded when the user first edits a drawn block (ADR 0029), so the main window starts without it.
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { MAX_BODY_BYTES } from '../../../core/noteLimits'
import { editedBlock } from '../../../core/plugins/blockEdit'
import { lineFeeds, utf8Length } from '../../../core/text'

/** A drawn block's edit (ADR 0029) in place of the block at `from`-`to`, or the code it is refused with. */
export function pluginBlockEdit(
  state: EditorState,
  block: { from: number; to: number; source: string },
  given: string,
): TransactionSpec | { code: string } {
  const { from, to } = block
  if (to > state.doc.length) return { code: 'E_PLUGIN_NOTE_CHANGED' }
  const replaced = state.sliceDoc(from, to)
  const text = editedBlock(replaced, block.source, lineFeeds(given))
  if (text === null) return { code: 'E_PLUGIN_NOTE_CHANGED' }
  const bytes = utf8Length(state.doc.toString()) - utf8Length(replaced) + utf8Length(text)
  if (bytes > MAX_BODY_BYTES) return { code: 'E_NOTE_BODY_TOO_LARGE' }
  return { changes: { from, to, insert: text }, userEvent: 'input.plugin' }
}
