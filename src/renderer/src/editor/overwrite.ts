// Overwrite mode: typed text replaces as many characters after each caret
// as it has, up to the end of the caret's line (at the end it is inserted).
// Characters are counted as the user sees them. A selection is replaced as usual, and pastes, new lines and what an input
// method composes are never overwritten. The mode belongs to the editor
// state, so each note opens with it off; the caret shows as a block while
// it is on.
import {
  EditorSelection,
  EditorState,
  findClusterBreak,
  StateEffect,
  StateField,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { editorComposes } from '../ime'

const toggle = StateEffect.define<null>()

export const overwriteMode = StateField.define<boolean>({
  create: () => false,
  update: (on, tr) => tr.effects.reduce((now, e) => (e.is(toggle) ? !now : now), on),
})

export function toggleOverwrite(view: EditorView): boolean {
  view.dispatch({ effects: toggle.of(null) })
  return true
}

/**
 * The change that types `text` over the characters after each caret, or
 * null when it is typed as usual: the mode is off, something is selected,
 * or `text` is empty or holds a line break.
 */
export function overwriteSpec(state: EditorState, text: string): TransactionSpec | null {
  if (!state.field(overwriteMode, false) || text === '' || /[\r\n]/.test(text)) return null
  if (state.selection.ranges.some((r) => !r.empty)) return null
  let count = 0
  for (let at = 0; at < text.length; at = findClusterBreak(text, at)) count++
  return state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head)
    let end = range.head - line.from
    for (let i = 0; i < count && end < line.length; i++) end = findClusterBreak(line.text, end)
    return {
      changes: { from: range.head, to: line.from + end, insert: text },
      range: EditorSelection.cursor(range.head + text.length),
    }
  })
}

const overwriteInput = EditorView.inputHandler.of((view, from, to, text) => {
  // Only text typed at the caret: a replacement of text before it (an
  // accent picked by holding a key, a correction) goes through as usual.
  if (editorComposes(view) || from !== to || from !== view.state.selection.main.head) return false
  const spec = overwriteSpec(view.state, text)
  if (!spec) return false
  view.dispatch(view.state.update(spec, { userEvent: 'input.type', scrollIntoView: true }))
  return true
})

const blockCaret = EditorView.baseTheme({
  '&.cm-overwrite .cm-cursor': { borderLeftWidth: '0.6em', opacity: '0.5' },
})

export function overwrite(): Extension {
  return [
    overwriteMode,
    overwriteInput,
    EditorView.editorAttributes.from(overwriteMode, (on) => (on ? { class: 'cm-overwrite' } : {})),
    blockCaret,
  ]
}
