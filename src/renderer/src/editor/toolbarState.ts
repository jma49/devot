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

export const hideToolbar = StateEffect.define<null>()
export const releaseToolbar = StateEffect.define<null>()
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

export const toolbarOff = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

export function toolbarVisible(state: EditorState): boolean {
  if (state.facet(toolbarOff) || state.readOnly) return false
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

export const toolbarStateExtension = [
  toolbarState,
  // Gaining focus is noted here; losing it below, where the new target is known.
  EditorView.focusChangeEffect.of((_state, focusing) =>
    focusing ? setToolbarFocus.of(true) : null,
  ),
  focusOut,
]

/**
 * Whether a control inside the bar has focus. The bars live in the editor's
 * shadow root, where `document.activeElement` is only the shadow host, so the
 * bar's own root is asked.
 */
export function barHoldsFocus(
  bar: Pick<Node, 'contains' | 'getRootNode' | 'ownerDocument'>,
): boolean {
  const root = bar.getRootNode() as Partial<DocumentOrShadowRoot>
  const active = root.activeElement
  return !!active && bar.contains(active)
}

/**
 * Whether focus is free to return to the editor after a bar's menu closed:
 * it is on the bar itself, or nowhere (not in another field of the page).
 */
export function barFocusIsFree(
  bar: Pick<Node, 'contains' | 'getRootNode' | 'ownerDocument'>,
): boolean {
  if (barHoldsFocus(bar)) return true
  const root = bar.getRootNode() as Partial<ShadowRoot>
  if (root.activeElement) return false
  const outer = bar.ownerDocument?.activeElement
  return !outer || outer === bar.ownerDocument?.body || outer === root.host
}

/**
 * Call when a bar goes away: a button of it that still has focus (a screen
 * reader pressed it) would leave focus on nothing, so it returns to the editor.
 */
export function releaseBarFocus(view: EditorView, bar: HTMLElement): void {
  const held = barHoldsFocus(bar)
  queueMicrotask(() => {
    if (!view.dom.isConnected) return
    if (held) view.focus()
    else if (!view.hasFocus && editorFocused(view.state)) {
      view.dispatch({ effects: setToolbarFocus.of(false) })
    }
  })
}

export function editorFocused(state: EditorState): boolean {
  return state.field(toolbarState, false)?.focused ?? false
}
