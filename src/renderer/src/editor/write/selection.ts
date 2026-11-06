// Write mode's selection, read as the ranges and lines that show their source.
import type { EditorState } from '@codemirror/state'

/** The selection's ranges that show source, in order and apart; a caret has `from === to`. */
export type Selected = readonly { from: number; to: number }[]

/** Lines shown as source, as 1-based first and last line numbers, in order and apart. */
export type Revealed = readonly { first: number; last: number }[]

/**
 * The selection's ranges. A caret counts only while the editor has the
 * keyboard, so a note just opened reads as a document; a selection always
 * counts, so what Find or a command selects shows its marks.
 */
export function selectedRanges(state: EditorState, focused: boolean): Selected {
  const spans = state.selection.ranges
    .filter((range) => focused || !range.empty)
    .map(({ from, to }) => ({ from, to }))
    .sort((a, b) => a.from - b.from)
  const merged: { from: number; to: number }[] = []
  for (const span of spans) {
    const prev = merged[merged.length - 1]
    if (prev && span.from <= prev.to) prev.to = Math.max(prev.to, span.to)
    else merged.push(span)
  }
  return merged
}

/** Whether a selected range meets `from`..`to`, its edges included. */
export function touches(selected: Selected, from: number, to: number): boolean {
  let lo = 0
  let hi = selected.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((selected[mid] as { to: number }).to < from) lo = mid + 1
    else hi = mid
  }
  const span = selected[lo]
  return span !== undefined && span.from <= to
}

export const selectedKey = (selected: Selected) =>
  selected.map((s) => `${s.from}-${s.to}`).join(',')

/** The lines the selected ranges are on: block rules reveal a block by its lines. */
export function revealedLines(state: EditorState, focused: boolean): Revealed {
  const merged: { first: number; last: number }[] = []
  for (const span of selectedRanges(state, focused)) {
    const first = state.doc.lineAt(span.from).number
    const last = state.doc.lineAt(span.to).number
    const prev = merged[merged.length - 1]
    if (prev && first <= prev.last + 1) prev.last = Math.max(prev.last, last)
    else merged.push({ first, last })
  }
  return merged
}

export function isRevealed(revealed: Revealed, line: number): boolean {
  let lo = 0
  let hi = revealed.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = revealed[mid] as { first: number; last: number }
    if (line < span.first) hi = mid - 1
    else if (line > span.last) lo = mid + 1
    else return true
  }
  return false
}
