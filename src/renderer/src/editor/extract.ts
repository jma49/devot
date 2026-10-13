// New Note from Selection, in the editor: the selected text is handed to
// whatever makes the note, and once that is done it is replaced by the link
// it returns, as one undo step. Making the note takes a moment (the core
// runs in a worker), so the range is tracked through edits made meanwhile;
// if the selected text itself changed, or the editor closed, it is left
// alone and the caller drops the new note. A selection that cuts into code
// or front matter is not moved: a link there would be plain text.
import { isolateHistory } from '@codemirror/commands'
import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { context, LITERAL_BLOCKS } from './formatContext'

/** What moving a selection needs of the editor view. */
export interface ExtractView {
  readonly state: EditorState
  dispatch(spec: TransactionSpec): void
}

interface Tracked {
  from: number
  to: number
}

const setTracked = StateEffect.define<Tracked | null>()

/** The range being moved, mapped through edits; null once an edit inside it changes its text. */
const tracked = StateField.define<Tracked | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setTracked)) return effect.value
    if (!value || !tr.docChanged) return value
    // An edit inside the range (not one just before or after it) drops it.
    let inside = false
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA < value.to && toA > value.from) inside = true
    })
    if (inside) return null
    return { from: tr.changes.mapPos(value.from, 1), to: tr.changes.mapPos(value.to, -1) }
  },
})

/** The editor extension that moving a selection needs. */
export const trackExtract = tracked

/** Whether `pos` is inside a code block, an HTML block or front matter that `from`–`to` cuts into. */
function cutsInto(node: SyntaxNode | null, from: number, to: number): boolean {
  for (; node; node = node.parent) {
    if (LITERAL_BLOCKS.includes(node.name) && (node.from < from || node.to > to)) return true
  }
  return false
}

/**
 * The main selection's text, or null when nothing (or only white space) is
 * selected, or the selection starts or ends inside code, HTML or front
 * matter (a whole block may be selected), or the note is not parsed that far.
 */
export function selectedText(state: EditorState): string | null {
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  if (text.trim() === '') return null
  const cx = context(state)
  if (!cx) return null
  const tree = cx.tree
  if (
    cutsInto(tree.resolveInner(from, 1), from, to) ||
    cutsInto(tree.resolveInner(to, -1), from, to)
  )
    return null
  return text
}

/** The user event of the replacement. */
const EXTRACT_EVENT = 'input.extract'

/**
 * Hands the selected text to `make` and replaces it with the text `make`
 * resolves to (a note link), the cursor after it. False, with the note left
 * alone, when nothing can be moved (see `selectedText`), another move is
 * under way, `make` gives nothing or fails, the selected text was edited
 * meanwhile, or the editor is gone (`alive` says false).
 */
export async function moveSelection(
  view: ExtractView,
  make: (text: string) => Promise<string | null>,
  alive: () => boolean = () => true,
): Promise<boolean> {
  const text = selectedText(view.state)
  if (text === null || view.state.field(tracked, false) !== null) return false
  const { from, to } = view.state.selection.main
  view.dispatch({ effects: setTracked.of({ from, to }) })
  const replacement = await make(text).catch(() => null)
  if (!alive()) return false
  const at = view.state.field(tracked, false)
  if (replacement === null || !at || view.state.sliceDoc(at.from, at.to) !== text) {
    if (at) view.dispatch({ effects: setTracked.of(null) })
    return false
  }
  view.dispatch({
    changes: { from: at.from, to: at.to, insert: replacement },
    selection: EditorSelection.cursor(at.from + replacement.length),
    effects: setTracked.of(null),
    userEvent: EXTRACT_EVENT,
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  })
  return true
}
