// The quote and list markers a line starts with, as the syntax tree has
// them. Text that only looks like a marker (`2020.` or `3)` on the second
// line of a paragraph, `-` under one) is not one. Shared by the format
// commands and Return, so both read a line's markers the same way.
import type { SyntaxNode } from '@lezer/common'

// One quote marker, or one list marker with the spaces after it, at the start of what is left of a line.
const QUOTE_AT = /^[ \t]*>[ \t]?/
const LIST_AT = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]*/

export interface LineMark {
  text: string
  quote: boolean
  mark: number
}

/**
 * The markers `text` (a line, or its start, at `from` in the document)
 * starts with, in order, each confirmed by a `QuoteMark` or `ListMark` node
 * starting at its marker. `nodeAt` is the innermost node at a position,
 * entering nodes that start there.
 */
export function lineMarks(
  text: string,
  from: number,
  nodeAt: (pos: number) => SyntaxNode,
): LineMark[] {
  const marks: LineMark[] = []
  let at = 0
  for (;;) {
    const rest = text.slice(at)
    const quote = QUOTE_AT.exec(rest)
    const found = quote ?? LIST_AT.exec(rest)
    if (!found) break
    const mark = from + at + found[0].length - found[0].trimStart().length
    const node = nodeAt(mark)
    if (node.from !== mark || node.name !== (quote ? 'QuoteMark' : 'ListMark')) break
    marks.push({ text: found[0], quote: !!quote, mark })
    at += found[0].length
  }
  return marks
}
