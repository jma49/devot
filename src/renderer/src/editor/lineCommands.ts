// The editor's line commands, on keys from the command registry (the
// `edit.*` commands): a plain new line, blank lines above and below, delete,
// select, move, copy, indent, join and sort lines, and open the link under the
// caret. Typing a backtick over a selection wraps it too. The keys sit in a
// compartment, so a change in Settings > Keyboard rebinds them in the open
// editor (see registryKeys.ts).
import {
  copyLineDown,
  copyLineUp,
  deleteLine,
  indentLess,
  indentMore,
  insertBlankLine,
  insertNewline,
  moveLineDown,
  moveLineUp,
  selectLine,
} from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  type ChangeSpec,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { editorCommandKeys, type CommandId } from '../commands/registry'
import { registryKeys } from './registryKeys'

/** What opens a link's address (the window opens a note link or a web page). */
export const linkOpener = Facet.define<
  (href: string) => void,
  ((href: string) => void) | undefined
>({ combine: (all) => all[0] })

/** How sorting compares lines. */
export interface SortOptions {
  caseSensitive: boolean
  reverse: boolean
}

/** The lines in order, upper and lower case alike unless `caseSensitive` (stable). */
export function sortedLines(lines: readonly string[], { caseSensitive, reverse }: SortOptions) {
  const key = (line: string) => (caseSensitive ? line : line.toLowerCase())
  const out = [...lines].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
  return reverse ? out.reverse() : out
}

/** The first and last line the main selection touches (a range ending at a line's start stops above it). */
function selectedLines(state: EditorState) {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from)
  const lastPos = to > from && state.doc.lineAt(to).from === to ? to - 1 : to
  return { first, last: state.doc.lineAt(lastPos) }
}

/** Sorts the selected lines; one change. A single line stays as it is. */
export function sortLines(options: SortOptions) {
  return (view: EditorView): boolean => {
    const { state } = view
    const { first, last } = selectedLines(state)
    if (first.number === last.number) return true
    const lines: string[] = []
    for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).text)
    const insert = sortedLines(lines, options).join(state.lineBreak)
    if (insert === state.sliceDoc(first.from, last.to)) return true
    view.dispatch({
      changes: { from: first.from, to: last.to, insert },
      selection: EditorSelection.range(first.from, first.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    })
    return true
  }
}

/**
 * Joins the selected lines into one, or a line with the next when nothing is
 * selected over more than one line: each line break and the indent after it
 * become one space (none where either side is blank).
 */
export function joinLines(view: EditorView): boolean {
  const { state } = view
  const { first, last: selectedLast } = selectedLines(state)
  const last =
    first.number === selectedLast.number && first.number < state.doc.lines
      ? state.doc.line(first.number + 1)
      : selectedLast
  if (last.number === first.number) return true
  const changes: ChangeSpec[] = []
  for (let n = first.number; n < last.number; n++) {
    const line = state.doc.line(n)
    const next = state.doc.line(n + 1)
    const indent = /^[ \t]*/.exec(next.text)?.[0].length ?? 0
    const space = line.text.trim() === '' || next.text.trim() === '' ? '' : ' '
    changes.push({ from: line.to, to: next.from + indent, insert: space })
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'delete.join' })
  return true
}

/** A blank line above the caret's line, with the same indent; the caret moves to it. */
export function insertLineAbove(view: EditorView): boolean {
  const { state } = view
  const spec = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from)
    const indent = /^[ \t]*/.exec(line.text)?.[0] ?? ''
    return {
      changes: { from: line.from, insert: `${indent}${state.lineBreak}` },
      range: EditorSelection.cursor(line.from + indent.length),
    }
  })
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** A link in the note: its source range, its label and its address. */
export interface LinkAt {
  /** The link's Markdown, `[text](address)`, `<address>` or the bare address. */
  from: number
  to: number
  /** The label of a `[text](address)` link; the address for the others. */
  text: string
  href: string
}

/** The link at `pos`: `[text](address)`, `<address>` or a bare one; undefined elsewhere. */
export function linkAt(state: EditorState, pos: number): LinkAt | undefined {
  const tree = syntaxTree(state)
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const link =
        node.name === 'Link' || node.name === 'Autolink'
          ? node
          : node.name === 'URL' &&
              (node.parent?.name === 'Link' || node.parent?.name === 'Autolink')
            ? node.parent
            : undefined
      const url = link ? link.getChild('URL') : node.name === 'URL' ? node : null
      if (!url) continue
      const href = addressOf(state.sliceDoc(url.from, url.to))
      if (href === undefined) continue
      const range = link ?? url
      return {
        from: range.from,
        to: range.to,
        text: (link && labelOf(state, link, url.from)) || href,
        href,
      }
    }
  }
  return undefined
}

const NOTE_URI = /^devot:\/\/note\//

/**
 * The link at `pos` that New Note from Link can turn into a note: not the
 * address of an image, and not a link to a note already.
 */
export function linkForNewNote(state: EditorState, pos: number): LinkAt | undefined {
  const link = linkAt(state, pos)
  if (!link || NOTE_URI.test(link.href)) return undefined
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(link.from, 1);
    node;
    node = node.parent
  ) {
    if (node.name === 'Image') return undefined
  }
  return link
}

/** The text between a link's brackets, none for an autolink. */
function labelOf(state: EditorState, link: SyntaxNode, urlFrom: number): string | undefined {
  if (link.name !== 'Link') return undefined
  const marks = link.getChildren('LinkMark')
  const close = marks.find((m) => m.from < urlFrom && state.sliceDoc(m.from, m.to) === ']')
  const open = marks[0]
  if (!open || !close) return undefined
  return state.sliceDoc(open.to, close.from) || undefined
}

const addressOf = (text: string) => text.replace(/^<|>$/g, '').trim() || undefined

/** Opens the link under the caret; false where there is none. */
export function openLinkAtCaret(view: EditorView): boolean {
  const href = linkAt(view.state, view.state.selection.main.head)?.href
  const open = view.state.facet(linkOpener)
  if (href === undefined || !open) return false
  open(href)
  return true
}

/** A backtick typed over selected text wraps it in backticks. */
export function wrapInBackticks(state: EditorState, text: string): TransactionSpec | null {
  if (text !== '`' || state.selection.ranges.every((r) => r.empty)) return null
  return state.changeByRange((range) =>
    range.empty
      ? {
          changes: { from: range.from, insert: text },
          range: EditorSelection.cursor(range.from + 1),
        }
      : {
          changes: [
            { from: range.from, insert: '`' },
            { from: range.to, insert: '`' },
          ],
          range: EditorSelection.range(range.from + 1, range.to + 1),
        },
  )
}

const backtickWrap = Prec.highest(
  EditorView.inputHandler.of((view, _from, _to, text) => {
    const spec = wrapInBackticks(view.state, text)
    if (!spec) return false
    view.dispatch(view.state.update(spec, { userEvent: 'input.type', scrollIntoView: true }))
    return true
  }),
)

const RUN: Partial<Record<CommandId, (view: EditorView) => boolean>> = {
  'edit.plainNewline': insertNewline,
  'edit.lineBelow': insertBlankLine,
  'edit.lineAbove': insertLineAbove,
  'edit.deleteLine': deleteLine,
  'edit.selectLine': selectLine,
  'edit.moveLineUp': moveLineUp,
  'edit.moveLineDown': moveLineDown,
  'edit.copyLineUp': copyLineUp,
  'edit.copyLineDown': copyLineDown,
  'edit.outdent': indentLess,
  'edit.indent': indentMore,
  'edit.openLink': openLinkAtCaret,
  'edit.sortLines': sortLines({ caseSensitive: false, reverse: false }),
  'edit.sortLinesReverse': sortLines({ caseSensitive: false, reverse: true }),
  'edit.sortLinesCase': sortLines({ caseSensitive: true, reverse: false }),
  'edit.sortLinesCaseReverse': sortLines({ caseSensitive: true, reverse: true }),
  'edit.joinLines': joinLines,
}

/** The commands this module runs. */
export const LINE_COMMANDS = Object.keys(RUN) as readonly CommandId[]

/** Their keys in effect, in CodeMirror key notation. */
export function lineKeys(): { id: CommandId; key: string }[] {
  return LINE_COMMANDS.flatMap((id) => editorCommandKeys(id).map((key) => ({ id, key })))
}

/** The line command keys (from the registry), ahead of CodeMirror's own bindings. */
export const lineCommandKeys: () => Extension = registryKeys(() =>
  Prec.high(
    keymap.of(lineKeys().map(({ id, key }) => ({ key, run: RUN[id]!, preventDefault: true }))),
  ),
)

/** The line commands and the backtick wrap, for the editor (`opener` opens a link's address). */
export function lineCommands(opener: (href: string) => void): Extension {
  return [lineCommandKeys(), backtickWrap, linkOpener.of(opener)]
}
