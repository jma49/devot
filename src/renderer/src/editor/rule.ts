// New blocks after the line with the cursor (a rule; a table, see
// insert.ts), as one transaction (one Yjs update, one undo step) like the
// formats. Insert Horizontal Rule puts a thematic break (`---`) there, with a
// blank line before it, so the line above never becomes a setext heading,
// and the cursor goes to a new line under it.
import {
  EditorSelection,
  type EditorState,
  type Line,
  type TransactionSpec,
} from '@codemirror/state'
import {
  blockAround,
  context,
  inFrontMatter,
  LITERAL_BLOCK_NAMES,
  nodeAt,
  rangeLines,
  spec,
  type Cx,
} from './formatContext'
import { mayBeFrontMatter } from './markdown'

/** Quote markers at the start of a line; a new block (a rule, a table) stays in the quote. */
export const QUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/
/** Blocks a new block goes after rather than into. */
const WHOLE_BLOCKS = new Set(['Table', 'SetextHeading1', 'SetextHeading2'])
/** What is left of an empty list item, task or heading (after its quote markers). */
const EMPTY_MARKER = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?|#{1,6})[ \t]*$/

/** Whether a line holds nothing but quote markers and spaces. */
const isBlank = (text: string) => text.replace(QUOTE_PREFIX, '').trim() === ''

/**
 * Whether the marker at `at` starts a list item or ATX heading with nothing
 * after it on its line (a task's box at most). The text alone cannot tell:
 * an empty item cannot interrupt a paragraph, so `2020.` or `*` under a
 * line of text is that paragraph's text.
 */
function emptyItemOrHeading(cx: Cx, line: Line, at: number): boolean {
  const mark = nodeAt(cx, at)
  const block = mark.parent
  if (!block || mark.from !== at) return false
  if (mark.name === 'HeaderMark') return block.name.startsWith('ATXHeading')
  if (mark.name !== 'ListMark' || block.name !== 'ListItem') return false
  for (let next = mark.nextSibling; next && next.from <= line.to; next = next.nextSibling) {
    const box = next.firstChild
    const after = box?.nextSibling
    if (next.name !== 'Task' || box?.name !== 'TaskMarker' || (after && after.from <= line.to))
      return false
  }
  return true
}

/** Where a new block goes for a line with a cursor. */
export interface Place {
  /** The line the block goes after, or in place of. */
  line: Line
  /** Its quote markers, which every line of the block repeats. */
  prefix: string
  /** The block takes the line's place: it is blank, or an empty list item or heading. */
  replace: boolean
  /** The line above is blank (or there is none). */
  aboveBlank: boolean
  /** The line below is blank (or there is none). */
  belowBlank: boolean
}

/**
 * Where new blocks go, one per line with a cursor (the line a selection
 * ends on), in order; null for none. Inside a table or a setext heading the
 * block goes after it; code, HTML and front matter take none, nor does a
 * state the parser has not reached.
 */
function places(state: EditorState): Place[] | null {
  const cx = context(state)
  if (!cx) return null
  const doc = state.doc
  const found = new Map<number, Place>()
  for (const range of state.selection.ranges) {
    const last = rangeLines(state, range).at(-1) ?? doc.lineAt(range.to).number
    let line = doc.line(last)
    // The line's text, after its indentation (an indented code block starts there).
    const at = line.from + line.text.length - line.text.trimStart().length
    if (inFrontMatter(cx, at) || blockAround(cx, at, LITERAL_BLOCK_NAMES)) continue
    const whole = blockAround(cx, at, WHOLE_BLOCKS)
    if (whole) line = doc.lineAt(whole.to)
    const prefix = QUOTE_PREFIX.exec(line.text)?.[0] ?? ''
    const rest = line.text.slice(prefix.length)
    const marker = line.from + line.text.length - rest.trimStart().length
    found.set(line.number, {
      line,
      prefix,
      // A setext underline (`-`) is not an empty list item.
      replace:
        rest.trim() === '' ||
        (!whole && EMPTY_MARKER.test(rest) && emptyItemOrHeading(cx, line, marker)),
      aboveBlank: line.number === 1 || isBlank(doc.line(line.number - 1).text),
      belowBlank: line.number === doc.lines || isBlank(doc.line(line.number + 1).text),
    })
  }
  return found.size === 0 ? null : [...found.values()].sort((a, b) => a.line.from - b.line.from)
}

/** A new block's lines (without quote markers), and where the cursor goes in it. */
export interface NewBlock {
  lines: readonly string[]
  /** A place in one of its lines; null: on a new line under the block. */
  cursor: { line: number; column: number } | null
}

/**
 * Inserts a block after each line with a cursor, as one transaction: in
 * place of a blank line or an empty list item or heading, otherwise after
 * the line; inside a quote, in the quote. A blank line keeps it apart from
 * text above (a rule there would make a setext heading, a table would take
 * the text as its header); below it, either the cursor gets a new line or a
 * blank line keeps it apart from text below (a table would take it as a row).
 */
export function insertBlocks(
  state: EditorState,
  make: (place: Place) => NewBlock,
): TransactionSpec | null {
  const found = places(state)
  if (!found) return null
  const inserts: { from: number; to: number; insert: string; cursor: number }[] = []
  // The line of the block before and whether that block ends its line (no new line under it).
  let open = -1
  for (const place of found) {
    const { line, prefix } = place
    // A line of only markers: `>` rather than `> `.
    const bare = prefix.trimEnd()
    const block = make(place)
    // A blank line above that the block before fills is not blank any more.
    const aboveBlank = place.aboveBlank && open !== line.number - 1
    const before = place.replace ? (aboveBlank ? '' : `${bare}\n`) : `\n${bare}\n`
    const body = block.lines.map((text) => prefix + text).join('\n')
    const after = block.cursor === null ? `\n${prefix}` : place.belowBlank ? '' : `\n${bare}`
    const insert = before + body + after
    open = after === '' ? line.number : -1
    let cursor = insert.length
    if (block.cursor !== null) {
      const above = block.lines.slice(0, block.cursor.line)
      cursor = before.length + above.reduce((n, text) => n + prefix.length + text.length + 1, 0)
      cursor += prefix.length + block.cursor.column
    }
    const from = place.replace ? line.from : line.to
    inserts.push({ from, to: line.to, insert, cursor })
  }
  const changes = state.changes(inserts)
  const cursors = inserts.map((c) => EditorSelection.cursor(changes.mapPos(c.from, -1) + c.cursor))
  return spec(changes, EditorSelection.create(cursors))
}

/**
 * Inserts a rule after each line with a cursor (the line a selection ends
 * on; the selected text stays), the cursor on a new line under it (see
 * insertBlocks). A rule that would start the note, or could close the `---`
 * a note starts with, is `***`: a `---` there would make front matter.
 */
export function insertRule(state: EditorState): TransactionSpec | null {
  return insertBlocks(state, ({ line, prefix, replace }) => {
    const marker =
      prefix === '' && ((replace && line.number === 1) || mayBeFrontMatter(state.doc, line.from))
        ? '***'
        : '---'
    return { lines: [marker], cursor: null }
  })
}
