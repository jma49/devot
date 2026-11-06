// Whether the editor has the keyboard, as state: Write mode's block
// decorations come from a state field, which cannot ask the view.
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { revealedLines, selectedRanges, type Revealed, type Selected } from './selection'

export const setWriteFocus = StateEffect.define<boolean>()

export const writeFocus = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) if (effect.is(setWriteFocus)) focused = effect.value
    return focused
  },
})

/** Kept outside Write mode too, so switching to it knows the keyboard at once. */
export const writeFocusTracking: Extension = [
  writeFocus,
  EditorView.focusChangeEffect.of((_state, focusing) => setWriteFocus.of(focusing)),
]

const focusedIn = (state: EditorState) => state.field(writeFocus, false) ?? false

export const selectedIn = (state: EditorState): Selected => selectedRanges(state, focusedIn(state))

export const revealedIn = (state: EditorState): Revealed => revealedLines(state, focusedIn(state))
