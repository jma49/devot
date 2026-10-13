// Return in a list or a quote. The Markdown language's own Return continues
// the markup of the line and, on an empty list item, takes its marker off.
// Two things it leaves out, which this wraps:
//
// - Leaving a list: the marker goes and the next line starts right under the
//   last item, so text typed there is a lazy continuation of that item (the
//   preview shows it inside the bullet). A blank line goes between them.
// - Leaving a quote: Return on an empty quote line continues the quote
//   again. It leaves it, as it does a list: one blank line, the cursor out.
//   On an empty line in the middle of a quote (a line of it follows), or in
//   a code block in a quote, Return goes on in the quote instead, so the
//   quote is never split in two.
//
// Both are one transaction, so one undo step. An empty second item of a list
// leaves it too: the language's own Return would loosen the list there (a
// blank line between its two items) and keep the cursor in it.
import { insertNewlineContinueMarkupCommand, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  Prec,
  type EditorState,
  type Extension,
  type Line,
  type Text,
  type Transaction,
} from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { lineMarks, type LineMark } from './lineMarks'

// What an empty list item or task is, after its quote markers.
const EMPTY_ITEM = /^[ \t>]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*$/
// A line with nothing but quote markers and spaces.
const bare = (text: string) => !/[^\s>]/.test(text)

const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
})

/**
 * The markers before the cursor on its line, when they are all that is
 * there (spaces aside) and the last one is a quote's: those the syntax tree
 * has, so text that only looks like a marker is not one. Null otherwise.
 */
function markersBefore(tree: Tree, line: Line, cursor: number): LineMark[] | null {
  const before = line.text.slice(0, cursor - line.from)
  const marks = lineMarks(before, line.from, (pos) => tree.resolveInner(pos, 1))
  const end = marks.reduce((at, mark) => at + mark.text.length, 0)
  if (!marks.at(-1)?.quote || !/^[ \t]*$/.test(before.slice(end))) return null
  return marks
}

/** How long Return may wait for the parser to read the line after the cursor's. */
const PARSE_MS = 50

/**
 * Return on an empty quote line (the cursor after the quote's marker, nothing
 * after it). At the end of the quote the marker of the innermost quote goes,
 * with a blank line above the cursor unless there is one already; when the
 * quote opens a list item, the item stays, empty. In the middle of the quote
 * (also in a list in it) or in a code block in it a new line of it follows.
 * Null for any other line.
 */
function leaveQuote(state: EditorState): Transaction | null {
  const range = state.selection.main
  if (state.selection.ranges.length !== 1 || !range.empty) return null
  const { doc } = state
  const line = doc.lineAt(range.from)
  if (/\S/.test(line.text.slice(range.from - line.from))) return null
  if (!markdownLanguage.isActiveAt(state, range.from, -1)) return null
  const next = line.number < doc.lines ? doc.line(line.number + 1).to : line.to
  const tree = ensureSyntaxTree(state, next, PARSE_MS) ?? syntaxTree(state)
  // Quote markers in the tree, not text in code or front matter.
  const marks = markersBefore(tree, line, range.from)
  const inner = marks?.at(-1)
  if (!marks || !inner) return null
  // The `>` of a line in a list or code block in the quote is in that block:
  // its quote is the nearest one above it. In code, the quote never splits.
  let quote = tree.resolveInner(inner.mark, 1).parent
  let inCode = false
  while (quote && quote.name !== 'Blockquote') {
    if (quote.name === 'FencedCode' || quote.name === 'CodeBlock') inCode = true
    quote = quote.parent
  }
  const insert =
    inCode || (quote && quote.to > line.to)
      ? goOn(marks, line, range.from)
      : marks.some((m) => !m.quote)
        ? openingItem(marks)
        : leaving(marks, line, doc)
  const changes = { from: line.from, to: line.to, insert }
  return state.update({
    changes,
    selection: EditorSelection.cursor(line.from + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  })
}

/**
 * The line and the next one of the quote, its markers continued (an item's
 * as its indent), with the indent typed after them up to the cursor.
 */
function goOn(marks: LineMark[], line: Line, cursor: number): string {
  const end = marks.reduce((at, mark) => at + mark.text.length, 0)
  const indent = line.text.slice(end, cursor - line.from)
  const next = marks.map((m) => (m.quote ? m.text : ' '.repeat(m.text.length))).join('') + indent
  return `${line.text.trimEnd()}\n${/[ \t]$/.test(next) ? next : `${next} `}`
}

/**
 * The line of a quote that opens a list item (`- > `), the quote left: the
 * item's marker and those before it stay, so the item stays, empty. It needs
 * no blank line: its marker starts a block of its own.
 */
const openingItem = (marks: LineMark[]) =>
  marks
    .slice(0, -1)
    .map((m) => m.text)
    .join('')

/**
 * The last line of a quote, the quote left: the outer quote markers stay, a
 * list item's marker as its indent, with a blank line above unless there is
 * one already.
 */
function leaving(marks: LineMark[], line: Line, doc: Text): string {
  const inner = marks.at(-1)?.text ?? ''
  const outer =
    marks
      .slice(0, -1)
      .map((m) => (m.quote ? m.text : ' '.repeat(m.text.length)))
      .join('') + inner.slice(0, inner.length - inner.trimStart().length)
  const apart = line.number > 1 && !bare(doc.line(line.number - 1).text)
  return apart ? `${outer.trimEnd()}\n${outer}` : outer
}

/**
 * The transaction the language's Return makes, with a blank line
 * added where it took an empty list item's marker off and left the cursor
 * right under a line of text (the text typed there would continue the
 * item). Null when the command does nothing.
 */
function continueList(state: EditorState): Transaction | null {
  let made: Transaction | null = null
  const handled = continueMarkup({
    state,
    dispatch: (tr: Transaction) => (made = tr),
  } as unknown as EditorView)
  if (!handled || !made) return null
  const tr: Transaction = made
  const range = state.selection.main
  if (state.selection.ranges.length !== 1 || !range.empty) return tr
  const oldLine = state.doc.lineAt(range.from)
  const now = tr.state.doc
  const cursor = tr.state.selection.main.head
  const line = now.lineAt(cursor)
  // The marker went and no line was added: the line is left with its quote markers only.
  if (
    !EMPTY_ITEM.test(oldLine.text) ||
    now.lines !== state.doc.lines ||
    line.number !== oldLine.number ||
    cursor !== line.to ||
    !bare(line.text) ||
    line.number === 1 ||
    bare(now.line(line.number - 1).text)
  )
    return tr
  const insert = `${line.text.trimEnd()}\n`
  const changes = tr.changes.compose(ChangeSet.of({ from: line.from, insert }, now.length))
  return state.update({
    changes,
    selection: EditorSelection.cursor(cursor + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  })
}

/**
 * Return in Markdown: the language's own, except that leaving a list or a
 * quote (Return on its empty last item or line) starts a separate paragraph.
 * False where it does nothing, as the language's command does.
 */
export function insertNewlineLeavingMarkup(view: EditorView): boolean {
  const tr = leaveQuote(view.state) ?? continueList(view.state)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

/** Return, ahead of the Markdown language's own (see `insertNewlineLeavingMarkup`). */
export const leaveMarkupKeys: Extension = Prec.high(
  keymap.of([{ key: 'Enter', run: insertNewlineLeavingMarkup }]),
)
