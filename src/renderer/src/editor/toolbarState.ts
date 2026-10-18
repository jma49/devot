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
import { EditorView, ViewPlugin } from '@codemirror/view'
import { FORMAT_EVENT } from './formats'

/** Hides the toolbar until the user selects again. */
export const hideToolbar = StateEffect.define<null>()
/** Lets the toolbar show for the next selection (closing the slash menu with Escape). */
export const releaseToolbar = StateEffect.define<null>()
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
      if (effect.is(releaseToolbar)) hidden = false
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

/**
 * Whether focus moving to `target` takes it out of the editor and its floating
 * bars. A bar's button holds focus when a screen reader presses it (the
 * pointer never focuses one); that still counts as the editor's focus, or the
 * bar would close under the button.
 */
export function leavesEditor(target: { closest(selector: string): unknown } | null): boolean {
  return !target?.closest('.cm-float-bar')
}

/**
 * Focus leaving the editor and its bars ends the editor's focus. The bars
 * may sit outside the editor's box (in a popup layer beside it), so one
 * listener on the editor's root sees the content and every bar button blur.
 */
const focusOut = ViewPlugin.define((view) => {
  const onOut = (event: Event) => {
    const from = event.target
    if (!(from instanceof Node && view.dom.contains(from)) && leavesEditor(asElement(from))) return
    const to = (event as FocusEvent).relatedTarget
    if (to instanceof Node && view.dom.contains(to)) return
    if (!leavesEditor(asElement(to))) return
    view.dispatch({ effects: setToolbarFocus.of(false) })
  }
  const root = view.dom.getRootNode()
  root.addEventListener('focusout', onOut)
  return { destroy: () => root.removeEventListener('focusout', onOut) }
})

const asElement = (target: EventTarget | null) => (target instanceof Element ? target : null)

/** The field plus the focus tracking it needs from the view. */
export const toolbarStateExtension = [
  toolbarState,
  // Gaining focus is noted here; losing it below, where the new target is known.
  EditorView.focusChangeEffect.of((_state, focusing) =>
    focusing ? setToolbarFocus.of(true) : null,
  ),
  focusOut,
]

/**
 * Call when a bar goes away: a button of it that still has focus (a screen
 * reader pressed it) would leave focus on nothing, so it returns to the editor.
 */
export function releaseBarFocus(view: EditorView, bar: HTMLElement): void {
  const held = bar.contains(bar.ownerDocument.activeElement)
  queueMicrotask(() => {
    if (!view.dom.isConnected) return
    if (held) view.focus()
    else if (!view.hasFocus && editorFocused(view.state)) {
      view.dispatch({ effects: setToolbarFocus.of(false) })
    }
  })
}

/** Whether the editor has focus, as the floating bars know it. */
export function editorFocused(state: EditorState): boolean {
  return state.field(toolbarState, false)?.focused ?? false
}
