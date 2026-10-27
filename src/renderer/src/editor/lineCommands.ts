// The editor's line and selection commands, on keys from the command registry (the `edit.*` commands); the
// palette runs them too (`runEditCommand`). A backtick typed over a selection wraps it. The keys sit in a
// compartment, so a change in Settings > Keyboard rebinds them in the open editor (see registryKeys.ts).
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  insertBlankLine,
  insertNewline,
  moveLineDown,
  moveLineUp,
  redoSelection,
  selectLine,
  selectMatchingBracket,
  undoSelection,
} from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { SearchCursor, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import {
  EditorSelection,
  EditorState,
  Facet,
  type SelectionRange,
  Prec,
  type ChangeSpec,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { noteIdOf } from '../../../core/links'
import { editorCommandKeys, type CommandId } from '../commands/registry'
import { toggleOverwrite } from './overwrite'
import { registryKeys } from './registryKeys'

export const linkOpener = Facet.define<
  (href: string) => void,
  ((href: string) => void) | undefined
>({ combine: (all) => all[0] })

/** The links the app opens: a note, or a web page over https. */
export const opensLink = (href: string) => noteIdOf(href) !== undefined || /^https:\/\//i.test(href)

export interface SortOptions {
  caseSensitive: boolean
  reverse: boolean
}

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

export interface LinkAt {
  /** The link's Markdown, `[text](address)`, `<address>` or the bare address. */
  from: number
  to: number
  /** The label of a `[text](address)` link; the address for the others. */
  text: string
  href: string
}

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

function labelOf(state: EditorState, link: SyntaxNode, urlFrom: number): string | undefined {
  if (link.name !== 'Link') return undefined
  const marks = link.getChildren('LinkMark')
  const close = marks.find((m) => m.from < urlFrom && state.sliceDoc(m.from, m.to) === ']')
  const open = marks[0]
  if (!open || !close) return undefined
  return state.sliceDoc(open.to, close.from) || undefined
}

const addressOf = (text: string) => text.replace(/^<|>$/g, '').trim() || undefined

export function openLinkAtCaret(view: EditorView): boolean {
  const href = linkAt(view.state, view.state.selection.main.head)?.href
  const open = view.state.facet(linkOpener)
  if (href === undefined || !open || !opensLink(href)) return false
  open(href)
  return true
}

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

/**
 * The next match of the selected text after the last range (from the start
 * again past the end) that is not selected yet; a whole word matches only
 * whole words. Null when every range does not hold the same text, or there is
 * no other match.
 */
function nextOccurrence(state: EditorState): { from: number; to: number } | null {
  const { ranges } = state.selection
  const first = ranges[0]!
  const text = state.sliceDoc(first.from, first.to)
  if (text === '' || ranges.some((r) => state.sliceDoc(r.from, r.to) !== text)) return null
  const word = state.wordAt(first.from)
  const wholeWord = word !== null && word.from === first.from && word.to === first.to
  const start = ranges[ranges.length - 1]!.to
  for (const [from, to] of [
    [start, state.doc.length],
    [0, start],
  ] as const) {
    const cursor = new SearchCursor(state.doc, text, from, to)
    while (!cursor.next().done) {
      const match = cursor.value
      if (ranges.some((r) => r.from === match.from)) continue
      if (wholeWord) {
        const at = state.wordAt(match.from)
        if (!at || at.from !== match.from || at.to !== match.to) continue
      }
      return match
    }
  }
  return null
}

/**
 * Skip and Select Next Occurrence: with a caret, selects the word there (as
 * Select Next Occurrence does); otherwise the last selection gives way to
 * the next match of its text.
 */
export function skipNextOccurrence(view: EditorView): boolean {
  const { state } = view
  const { ranges } = state.selection
  if (ranges.some((r) => r.empty)) return selectNextOccurrence(view)
  const match = nextOccurrence(state)
  if (!match) return false
  // The main range is the one added last, wherever it sits in the document
  // (Select Next wraps around to the start).
  const kept = ranges.filter((_, i) => i !== state.selection.mainIndex)
  const added = EditorSelection.range(match.from, match.to)
  view.dispatch({
    selection: EditorSelection.create([...kept, added], kept.length),
    effects: EditorView.scrollIntoView(match.to),
    userEvent: 'select.search',
  })
  return true
}

/**
 * Split Selection into Lines: a range per line each selection covers (a last
 * line it only reaches the start of is left out); carets stay.
 */
export function splitSelectionIntoLines(view: EditorView): boolean {
  const { state } = view
  const out: SelectionRange[] = []
  for (const range of state.selection.ranges) {
    if (range.empty) {
      out.push(range)
      continue
    }
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      if (n > first && line.from === range.to) break
      out.push(EditorSelection.range(Math.max(range.from, line.from), Math.min(range.to, line.to)))
    }
  }
  view.dispatch({
    selection: EditorSelection.create(out, out.length - 1),
    userEvent: 'select',
  })
  return true
}

/**
 * Upper or lower case for each selection, or the word at each caret; the
 * selection stays on the same text (the caret stays put). False when nothing
 * changes.
 */
export function changeCase(upper: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view
    if (state.readOnly) return false
    // The text each range changes; two carets in one word change it once.
    const spans: { from: number; to: number; insert: string }[] = []
    for (const range of state.selection.ranges) {
      const span = range.empty ? state.wordAt(range.head) : range
      if (!span || spans.some((d) => d.from < span.to && span.from < d.to)) continue
      const text = state.sliceDoc(span.from, span.to)
      const insert = upper ? text.toUpperCase() : text.toLowerCase()
      if (insert !== text) spans.push({ from: span.from, to: span.to, insert })
    }
    if (spans.length === 0) return false
    const changes = state.changes(spans)
    // A position in a changed span keeps its offset there (within the new text).
    const map = (pos: number, assoc: -1 | 1) => {
      const span = spans.find((d) => d.from <= pos && pos <= d.to)
      if (!span) return changes.mapPos(pos, assoc)
      const from = changes.mapPos(span.from, -1)
      if (pos === span.to) return from + span.insert.length
      return from + Math.min(pos - span.from, span.insert.length)
    }
    const ranges = state.selection.ranges.map((r) =>
      r.empty
        ? EditorSelection.cursor(map(r.head, 1))
        : EditorSelection.range(
            map(r.anchor, r.anchor < r.head ? -1 : 1),
            map(r.head, r.anchor < r.head ? 1 : -1),
          ),
    )
    view.dispatch({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      userEvent: 'input.case',
    })
    return true
  }
}

function taskMarkOn(state: EditorState, line: { from: number; to: number }): number | null {
  let mark: number | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (mark !== null) return false
      if (node.name === 'TaskMarker' && node.from >= line.from && node.to <= line.to) {
        mark = node.from + 1
        return false
      }
      return undefined
    },
  })
  return mark
}

/**
 * Ticks the task box on each line with a caret or selection, or unticks them
 * all when every one is ticked. False when no such line is a task.
 */
export function toggleTaskAtCaret(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly) return false
  const marks: number[] = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      if (n > first && line.from === range.to) continue
      const mark = taskMarkOn(state, line)
      if (mark !== null) marks.push(mark)
    }
  }
  if (marks.length === 0) return false
  const tick = marks.some((at) => state.sliceDoc(at, at + 1) === ' ')
  const changes = marks
    .filter((at) => (state.sliceDoc(at, at + 1) === ' ') === tick)
    .map((at) => ({ from: at, to: at + 1, insert: tick ? 'x' : ' ' }))
  view.dispatch({ changes, userEvent: 'input.task' })
  return true
}

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
  'edit.addCursorAbove': addCursorAbove,
  'edit.addCursorBelow': addCursorBelow,
  'edit.selectNextOccurrence': selectNextOccurrence,
  'edit.skipNextOccurrence': skipNextOccurrence,
  'edit.selectAllMatches': selectSelectionMatches,
  'edit.splitSelectionIntoLines': splitSelectionIntoLines,
  'edit.undoSelection': undoSelection,
  'edit.redoSelection': redoSelection,
  'edit.goToBracket': cursorMatchingBracket,
  'edit.selectToBracket': selectMatchingBracket,
  'edit.upperCase': changeCase(true),
  'edit.lowerCase': changeCase(false),
  'edit.toggleTask': toggleTaskAtCaret,
  'edit.toggleOverwrite': toggleOverwrite,
}

export const LINE_COMMANDS = Object.keys(RUN) as readonly CommandId[]

/** Runs one of them on `view` (the palette); false when it did nothing or is not one of them. */
export function runEditCommand(view: EditorView, id: CommandId): boolean {
  const run = RUN[id]
  return run ? run(view) : false
}

export function lineKeys(): { id: CommandId; key: string }[] {
  return LINE_COMMANDS.flatMap((id) => editorCommandKeys(id).map((key) => ({ id, key })))
}

export const lineCommandKeys: () => Extension = registryKeys(() =>
  Prec.high(
    keymap.of(lineKeys().map(({ id, key }) => ({ key, run: RUN[id]!, preventDefault: true }))),
  ),
)

export function lineCommands(opener: (href: string) => void): Extension {
  return [lineCommandKeys(), backtickWrap, linkOpener.of(opener)]
}
