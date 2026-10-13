// When the selection toolbar shows: the editor has focus, the main
// selection is not empty, and the user has not hidden it (Escape) or started
// typing since the selection last changed on its own (a select event, or any
// transaction that sets a selection without editing, like Edit > Select All).
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { FORMAT_EVENT } from './formats'

/** Hides the toolbar until the user selects again. */
export const hideToolbar = StateEffect.define<null>()
/** The editor gained (true) or lost (false) focus. */
export const setToolbarFocus = StateEffect.define<boolean>()

interface ToolbarState {
  focused: boolean
  hidden: boolean
}

function typing(tr: Transaction): boolean {
  if (!tr.docChanged || tr.isUserEvent(FORMAT_EVENT)) return false
  return tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move')
}

export const toolbarState = StateField.define<ToolbarState>({
  create: () => ({ focused: false, hidden: false }),
  update(value, tr) {
    let { focused, hidden } = value
    if (typing(tr)) hidden = true
    else if (tr.isUserEvent('select') || (tr.selection && !tr.docChanged)) hidden = false
    for (const effect of tr.effects) {
      if (effect.is(setToolbarFocus)) focused = effect.value
      if (effect.is(hideToolbar)) hidden = true
    }
    return focused === value.focused && hidden === value.hidden ? value : { focused, hidden }
  },
})

/** Set by Settings > Editing > Toolbar when it is off: the toolbar never shows. */
export const toolbarOff = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

export function toolbarVisible(state: EditorState): boolean {
  if (state.facet(toolbarOff)) return false
  const value = state.field(toolbarState, false)
  return !!value && value.focused && !value.hidden && !state.selection.main.empty
}

/** The field plus the focus tracking it needs from the view. */
export const toolbarStateExtension = [
  toolbarState,
  EditorView.focusChangeEffect.of((_state, focusing) => setToolbarFocus.of(focusing)),
]

/** Whether the editor has focus, as the floating bars know it. */
export function editorFocused(state: EditorState): boolean {
  return state.field(toolbarState, false)?.focused ?? false
}
