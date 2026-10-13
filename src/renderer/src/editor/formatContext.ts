// What every format command shares: the transaction shape (one change set,
// the `input.format` user event, isolated history) and the syntax tree of a
// state, parsed once and reused by the toolbar and the commands.
import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { lineMarks } from './lineMarks'
import { FRONT_MATTER } from './markdown'

/** The first line of an alert: a quote whose text is `[!NOTE]` and so on. */
export const ALERT_LINE = /^ {0,3}>[ \t]?\[!(note|tip|important|warning|caution)\][ \t]*$/i

/**
 * Blocks whose text is literal (code, HTML, front matter): no format puts
 * markers inside them.
 */
export const LITERAL_BLOCKS: readonly string[] = [
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  FRONT_MATTER,
]

/**
 * Syntax in which a typed trigger (a slash, `[[`) is text: code, HTML,
 * comments and front matter, and the address and title of a link.
 */
export const LITERAL_TEXT: ReadonlySet<string> = new Set([
  ...LITERAL_BLOCKS,
  'InlineCode',
  'URL',
  'Autolink',
  'LinkTitle',
  'HTMLTag',
  'Comment',
  'ProcessingInstruction',
])

/** The literal blocks' node names, as a set. */
export const LITERAL_BLOCK_NAMES: ReadonlySet<string> = new Set(LITERAL_BLOCKS)

/** A format command: the transaction to dispatch, or null when nothing applies. */
export type FormatCommand = (state: EditorState) => TransactionSpec | null

/** The user event of every format transaction. */
export const FORMAT_EVENT = 'input.format'

export function spec(changes: ChangeSpec, selection: EditorSelection): TransactionSpec {
  return {
    changes,
    selection,
    userEvent: FORMAT_EVENT,
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  }
}

/** How long a command may spend parsing the part of the note it needs. */
export const COMMAND_PARSE_MS = 500
/** How long the toolbar may wait for the parser each time it renders. */
export const TOOLBAR_PARSE_MS = 50
/**
 * The most lines of selection (all ranges together) the toolbar reads to show
 * which formats are on. The toolbar works this out again each time the
 * selection changes, a Shift+Arrow at a time: reading every line of a long
 * selection took close to a second on a large note.
 */
export const TOOLBAR_MAX_LINES = 300
/** How far past the selection a paragraph is parsed (a setext underline ends it). */
const PARAGRAPH_LOOKAHEAD = 100

/**
 * A state and its syntax tree, parsed through the end of the selection's
 * paragraph. Every lookup reuses it: parsing per line restarts the parser
 * each time, which makes a large selection quadratic. The inline and block
 * formats keep what they work out from it per context, in weak maps.
 */
export interface Cx {
  state: EditorState
  tree: Tree
}

const contexts = new WeakMap<EditorState, Cx>()

/**
 * The context of a state, shared by the toolbar and the commands. Null when
 * the parser cannot reach the end of the selection within `budget`: a tree
 * that stops short would make unparsed code blocks look like plain text.
 */
export function context(state: EditorState, budget = COMMAND_PARSE_MS): Cx | null {
  const known = contexts.get(state)
  if (known) return known
  const to = Math.max(...state.selection.ranges.map((r) => r.to))
  let line = state.doc.lineAt(to)
  for (let i = 0; i < PARAGRAPH_LOOKAHEAD && line.number < state.doc.lines; i++) {
    if (line.text.trim() === '') break
    line = state.doc.line(line.number + 1)
  }
  const tree = ensureSyntaxTree(state, line.to, budget)
  if (!tree) return null
  const cx: Cx = { state, tree }
  contexts.set(state, cx)
  return cx
}

/**
 * Whether `pos` is in the note's front matter, its fences and blank lines
 * included. Formats leave all of it alone: it is YAML, not Markdown.
 */
export function inFrontMatter(cx: Cx, pos: number): boolean {
  const first = cx.tree.topNode.firstChild
  return first?.name === FRONT_MATTER && pos <= first.to
}

const nodes = new WeakMap<Cx, Map<number, SyntaxNode>>()

/**
 * The innermost node at `pos` (entering nodes that start there), looked up
 * once per context: the toolbar reads the same line starts for several formats.
 */
export function nodeAt(cx: Cx, pos: number): SyntaxNode {
  let known = nodes.get(cx)
  if (!known) nodes.set(cx, (known = new Map()))
  let node = known.get(pos)
  if (!node) known.set(pos, (node = cx.tree.resolveInner(pos, 1)))
  return node
}

/** The innermost node named in `names` at or around `pos` (see nodeAt), if any. */
export function blockAround(cx: Cx, pos: number, names: ReadonlySet<string>): SyntaxNode | null {
  for (let node: SyntaxNode | null = nodeAt(cx, pos); node; node = node.parent) {
    if (names.has(node.name)) return node
  }
  return null
}

/**
 * Where a line's own text starts (an offset in it): after the quote and list
 * markers the syntax tree has there, and the spaces after them. Text that
 * only looks like a marker (`2020.` or `3)` on the second line of a
 * paragraph, `-` under one) is not a marker, and is not skipped.
 */
export function containerEnd(cx: Cx, line: Line): number {
  let at = 0
  for (const mark of lineMarks(line.text, line.from, (pos) => nodeAt(cx, pos)))
    at += mark.text.length
  while (at < line.length && /[ \t]/.test(line.text.charAt(at))) at++
  return at
}

/**
 * Whether a line is an alert's header (`> [!NOTE]`), the first line of its
 * quote. Its text is the alert's kind, which no format may change: markers
 * around it would make the quote a plain one.
 */
export function alertHeader(cx: Cx, line: Line): boolean {
  if (!ALERT_LINE.test(line.text)) return false
  const mark = line.from + line.text.indexOf('>')
  const node = nodeAt(cx, mark)
  return (
    node.name === 'QuoteMark' && node.parent?.name === 'Blockquote' && node.parent.from === mark
  )
}

/** The lines a range covers; a range ending at the start of a line leaves that line out. */
export function rangeLines(state: EditorState, range: SelectionRange): number[] {
  const first = state.doc.lineAt(range.from).number
  const lastLine = state.doc.lineAt(range.to)
  const last =
    range.to === lastLine.from && lastLine.number > first ? lastLine.number - 1 : lastLine.number
  const lines: number[] = []
  for (let n = first; n <= last; n++) lines.push(n)
  return lines
}

/** Whether the selection is short enough for the toolbar to read (see `TOOLBAR_MAX_LINES`). */
export function toolbarReads(state: EditorState): boolean {
  let lines = 0
  for (const { from, to } of state.selection.ranges) {
    lines += state.doc.lineAt(to).number - state.doc.lineAt(from).number + 1
    if (lines > TOOLBAR_MAX_LINES) return false
  }
  return true
}
