// Block formats: code blocks, lists, quotes and alerts. Each acts on every
// line the selection touches and, like the inline formats, is one
// transaction (one Yjs update, one undo step) editing the Markdown source.
// Applying a format the lines already have removes it; switching between
// list kinds converts the markers. Lines of fenced code and other literal
// blocks are left alone, except by the code block format itself and when a
// quote takes them along with the list item they are in.
import { markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  Facet,
  type ChangeSpec,
  type EditorState,
  type Line,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { AlertKind } from '../../../core/preview/registry'
import {
  ALERT_LINE,
  COMMAND_PARSE_MS,
  containerEnd,
  context,
  inFrontMatter,
  LITERAL_BLOCKS,
  nodeAt,
  rangeLines,
  spec,
  TOOLBAR_PARSE_MS,
  toolbarReads,
  type Cx,
} from './formatContext'
import { mayBeFrontMatter, noteParser } from './markdown'

export type { AlertKind } from '../../../core/preview/registry'

/** The bullet a new list item gets (Settings > Editing > Unordered List Bullet); `-` without settings. */
export const listBullet = Facet.define<'-' | '*' | '+', '-' | '*' | '+'>({
  combine: (values) => values[0] ?? '-',
})
export type ListKind = 'bullet' | 'numbered' | 'task'
export type BlockFormat =
  | 'codeBlock'
  | 'bulletList'
  | 'numberedList'
  | 'taskList'
  | 'quote'
  | 'alert'

/** The alert kinds, in the order the pop-up lists them. */
export const ALERT_KINDS: readonly AlertKind[] = ['note', 'tip', 'important', 'warning', 'caution']

// One quote marker at the start of a line.
const QUOTE_MARK = /^ {0,3}>[ \t]?/
// A list marker (bullet, or number and delimiter) and a task box after it.
const MARKER = /^(?:([-*+])|(\d{1,9})([.)]))(?=[ \t]|$)/
const BOX = /^\[[ xX]\](?=[ \t]|$)/
const LEADING_FENCE = /^[ \t]*(`+)/

const CODE = new Set(LITERAL_BLOCKS)
// Blocks that list markers would break.
const NOT_LISTABLE = new Set([...CODE, 'Table', 'HorizontalRule', 'LinkReference'])
// Marks of containers: a line's quote or list marker is not inside the block after it.
const CONTAINER_MARKS = new Set(['QuoteMark', 'ListMark'])

const isBlank = (text: string) => text.trim() === ''
// Paragraph text: a task item's text is a paragraph too.
const PARAGRAPHS = new Set(['Paragraph', 'Task'])

/** How many quote markers a line starts with, and how long they are. */
function quotePrefix(text: string, limit = Infinity): { count: number; length: number } {
  let count = 0
  let length = 0
  while (count < limit) {
    const m = QUOTE_MARK.exec(text.slice(length))
    if (!m) break
    count++
    length += m[0].length
  }
  return { count, length }
}

/**
 * Where a line's text starts (an offset in it): after its first `quotes`
 * quote markers (all of them by default) and the indent after them.
 */
function textStart(line: Line, quotes = Infinity): number {
  let i = quotePrefix(line.text, quotes).length
  while (i < line.length && /[ \t]/.test(line.text.charAt(i))) i++
  return i
}

/** The selected line numbers, each once, in order. */
function selectedLines(state: EditorState): number[] {
  const numbers = new Set<number>()
  for (const range of state.selection.ranges)
    for (const n of rangeLines(state, range)) numbers.add(n)
  return [...numbers].sort((a, b) => a - b)
}

const commandContexts = new WeakMap<EditorState, Cx>()
/** How far the parser is pushed at a time while looking for the end of the selection's blocks. */
const PARSE_STEP = 20_000
/**
 * How long a block command may parse in all. It needs the whole selection
 * and the block after it, which on a large selection takes far longer than
 * what an inline format needs, the more so on a busy machine. Each step of
 * the parse still has to finish within `COMMAND_PARSE_MS`: a parser that
 * makes no progress is not waited for.
 */
const BLOCK_PARSE_MS = 4 * COMMAND_PARSE_MS

/**
 * The context a block command works in. Renumbering a list and moving an
 * item's children reach past the selection, though never past the top-level
 * block after the one the selection ends in: the note is parsed, a step at
 * a time, until that block is complete (another one follows it) or to its
 * end. Null when the parser cannot get there in time.
 */
function commandContext(state: EditorState): Cx | null {
  const known = commandContexts.get(state)
  if (known) return known
  const { doc } = state
  const deadline = Date.now() + BLOCK_PARSE_MS
  const end = doc.lineAt(Math.max(...state.selection.ranges.map((r) => r.to))).to
  let upto = Math.min(end, PARSE_STEP)
  for (;;) {
    const left = Math.min(deadline - Date.now(), COMMAND_PARSE_MS)
    const tree = left > 0 ? ensureSyntaxTree(state, Math.min(upto, doc.length), left) : null
    if (!tree) return null
    if (tree.length >= end) {
      const block = topBlock(tree, end, -1) ?? topBlock(tree, end, 1)
      if (tree.length >= doc.length || block?.nextSibling?.nextSibling) {
        const cx: Cx = { state, tree }
        commandContexts.set(state, cx)
        return cx
      }
    }
    upto = tree.length < end ? Math.min(end, tree.length + PARSE_STEP) : tree.length + PARSE_STEP
  }
}

/** Whether `pos` is inside literal text (code, HTML), not at a container's marker. */
function inCode(cx: Cx, pos: number): boolean {
  const node = nodeAt(cx, pos)
  if (CONTAINER_MARKS.has(node.name)) return false
  for (let n: SyntaxNode | null = node; n; n = n.parent) if (CODE.has(n.name)) return true
  return false
}

/** Collects edits in document order and builds one change set from them. */
class Edits {
  private specs: { from: number; to: number; insert: string; order: number }[] = []

  add(from: number, to: number, insert = '') {
    if (from === to && insert === '') return
    this.specs.push({ from, to, insert, order: this.specs.length })
  }

  /**
   * Edits at one position apply insertions first, in the order added.
   * Overlapping deletions (the two fences of an empty block) are merged.
   */
  changes(doc: Text): ChangeSet {
    const pure = (s: { from: number; to: number }) => (s.from === s.to ? 0 : 1)
    const sorted = [...this.specs].sort(
      (a, b) => a.from - b.from || pure(a) - pure(b) || a.order - b.order,
    )
    const merged: ChangeSpec[] = []
    let last: { from: number; to: number; insert: string } | undefined
    for (const s of sorted) {
      if (last && (s.from < last.to || (s.from === last.to && last.from === last.to))) {
        last.to = Math.max(last.to, s.to)
        last.insert += s.insert
        continue
      }
      last = { from: s.from, to: s.to, insert: s.insert }
      merged.push(last)
    }
    return ChangeSet.of(merged, doc.length)
  }

  get empty() {
    return this.specs.length === 0
  }
}

/**
 * Moves lines sideways: positive deltas insert spaces at a position, negative
 * ones remove up to that many spaces there. Deltas at one position add up.
 */
class Shifts {
  private deltas = new Map<number, { line: number; delta: number }>()

  add(line: number, pos: number, delta: number) {
    if (delta !== 0)
      this.deltas.set(pos, { line, delta: (this.deltas.get(pos)?.delta ?? 0) + delta })
  }

  /**
   * Moves the lines after an item's first line (its children and the rest of
   * its text) by `delta`, after the `quotes` quote markers the item sits in.
   */
  children(doc: Text, item: { from: number; to: number }, quotes: number, delta: number) {
    if (delta === 0) return
    const first = doc.lineAt(item.from).number
    const last = doc.lineAt(item.to).number
    for (let n = first + 1; n <= last; n++) {
      const line = doc.line(n)
      const prefix = quotePrefix(line.text, quotes)
      if (prefix.count < quotes || isBlank(line.text.slice(prefix.length))) continue
      this.add(n, line.from + prefix.length, delta)
    }
  }

  /** Adds the moves to `edits`, except on the lines in `keep`. */
  into(edits: Edits, doc: Text, keep?: Set<number>) {
    for (const [pos, { line, delta }] of this.deltas) {
      if (keep?.has(line)) continue
      if (delta > 0) {
        edits.add(pos, pos, ' '.repeat(delta))
        continue
      }
      let end = pos
      while (end < pos - delta && doc.sliceString(end, end + 1) === ' ') end++
      edits.add(pos, end)
    }
  }
}

/**
 * The selection after a block edit: ranges keep to the text they covered
 * (markers inserted at their start go before them) and cursors stay with
 * the text after them. `after` holds edits made in the new document that go
 * after the selected text, like a closing fence.
 */
function mapSelection(state: EditorState, changes: ChangeSet, after?: ChangeSet): EditorSelection {
  const map = (pos: number, assoc: 1 | -1) => {
    let mapped = changes.mapPos(pos, assoc)
    // A marker replaced at the position (`- ` becoming `1. `) goes before it too.
    if (assoc > 0)
      changes.iterChanges((fromA, toA, _fromB, toB) => {
        if (fromA === pos && toA > fromA) mapped = Math.max(mapped, toB)
      })
    return after ? after.mapPos(mapped, -1) : mapped
  }
  const ranges = state.selection.ranges.map((r) => {
    if (r.empty) return EditorSelection.cursor(map(r.head, 1))
    const from = map(r.from, 1)
    const to = Math.max(from, map(r.to, -1))
    return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
  })
  return EditorSelection.create(ranges, state.selection.mainIndex)
}

// Lists

interface Marker {
  bullet: string | undefined
  number: string | undefined
  delim: string | undefined
  task: boolean
  /** Where the item's content starts, from the marker: the indent of its children. */
  offset: number
  /** Where the line's own text starts, after the marker, its spaces and a task box. */
  textFrom: number
}

interface ListLine {
  line: Line
  /** Where the line's marker is (or would go): after its quote markers and indent. */
  at: number
  quotes: number
  marker: Marker | null
  /** The item the line starts, when the parser reads it as one. */
  item: SyntaxNode | null
  blank: boolean
  /** The line continues an item above it, indented under its text. */
  continuation: boolean
}

type ListRole = ListLine | 'skip'

function parseMarker(line: Line, at: number): Marker | null {
  const i = at - line.from
  const m = MARKER.exec(line.text.slice(i))
  if (!m) return null
  const end = i + m[0].length
  let spaces = 0
  while (end + spaces < line.length && /[ \t]/.test(line.text.charAt(end + spaces))) spaces++
  const atEnd = end + spaces === line.length
  const wide = atEnd || spaces > 4
  // Five spaces or more start indented code inside the item: only one belongs to the marker.
  let textFrom = end + (atEnd ? spaces : wide ? 1 : spaces)
  const task = !wide && BOX.test(line.text.slice(textFrom))
  if (task) {
    textFrom += 3
    while (textFrom < line.length && /[ \t]/.test(line.text.charAt(textFrom))) textFrom++
  }
  return {
    bullet: m[1],
    number: m[2],
    delim: m[3],
    task,
    offset: m[0].length + (wide ? 1 : spaces),
    textFrom: line.from + textFrom,
  }
}

const kindOf = (marker: Marker | null): ListKind | null =>
  !marker ? null : marker.task ? 'task' : marker.number ? 'numbered' : 'bullet'

const listRoles = new WeakMap<Cx, Map<number, ListRole>>()

/**
 * What a line is to the list formats: an item or a line that can become one,
 * possibly the indented continuation of an item above; or `skip`, part of a
 * block list markers would break. A line that continues an item lazily,
 * without the indent, counts as a line of its own.
 */
function listRole(cx: Cx, n: number): ListRole {
  let known = listRoles.get(cx)
  if (!known) listRoles.set(cx, (known = new Map()))
  const cached = known.get(n)
  if (cached) return cached
  const line = cx.state.doc.line(n)
  const at = line.from + textStart(line)
  const node = nodeAt(cx, at)
  let role: ListRole | undefined
  for (let p: SyntaxNode | null = node; p && !role; p = p.parent) {
    if (NOT_LISTABLE.has(p.name)) role = 'skip'
    // A marker on a setext heading's text would leave its underline behind.
    else if (p.name.startsWith('SetextHeading')) role = 'skip'
  }
  let item: SyntaxNode | null = null
  let continuation = false
  if (!role) {
    if (node.name === 'ListMark' && node.from === at) item = node.parent
    else {
      let p: SyntaxNode | null = node
      while (p && p.name !== 'ListItem') p = p.parent
      // A blank line is never a continuation: it can start an item there.
      if (p && p.from < line.from && at < line.to)
        continuation = at - line.from > p.from - cx.state.doc.lineAt(p.from).from
    }
  }
  role ??= {
    line,
    at,
    quotes: quotePrefix(line.text).count,
    // Text that only looks like a marker (`2020.` in a paragraph) is not one.
    marker: item ? parseMarker(line, at) : null,
    item,
    blank: at === line.to,
    continuation,
  }
  known.set(n, role)
  return role
}

/**
 * The selected lines a list format works on: blank ones only when alone, and
 * the continuation of an item only when no other line is selected (it then
 * becomes an item nested in that one).
 */
function listLines(cx: Cx): ListLine[] {
  const numbers = selectedLines(cx.state)
  const lines: ListLine[] = []
  for (const n of numbers) {
    const role = listRole(cx, n)
    if (role === 'skip') continue
    if (role.blank && !role.marker && numbers.length > 1) continue
    lines.push(role)
  }
  const own = lines.filter((l) => !l.continuation)
  return own.length > 0 ? own : lines
}

function listActive(lines: ListLine[], kind: ListKind): boolean {
  return lines.length > 0 && lines.every((l) => kindOf(l.marker) === kind)
}

/**
 * The marker a line gets for `kind`. Bullets keep their character, and a
 * new one is `newBullet` (the list marker setting); a new number takes `delim` (that of the list it joins) and renumbering sets it.
 */
function newMarker(
  marker: Marker | null,
  kind: ListKind,
  delim: string,
  newBullet: string,
): { text: string; offset: number } {
  const bullet = marker?.bullet ?? newBullet
  if (kind === 'bullet') return { text: `${bullet} `, offset: 2 }
  if (kind === 'task') return { text: `${bullet} [ ] `, offset: 2 }
  const number = marker?.number ? `${marker.number}${marker.delim ?? delim}` : `1${delim}`
  return { text: `${number} `, offset: number.length + 1 }
}

/** Where a line's marker sits: its quote depth and column. */
const slot = (l: ListLine) => `${l.quotes}:${l.at - l.line.from}`

/**
 * The delimiter (`.` or `)`) of the numbered item a line would follow: the
 * nearest line above it in the same position, past blank and continuation
 * lines. Undefined when there is none.
 */
function delimAbove(cx: Cx, l: ListLine): string | undefined {
  for (let n = l.line.number - 1; n >= 1; n--) {
    const role = listRole(cx, n)
    if (role === 'skip') return undefined
    if (role.blank || role.continuation) continue
    return slot(role) === slot(l) ? role.marker?.delim : undefined
  }
  return undefined
}

/** The top-level block at `pos`, or the nearest one before or after it. */
function topBlock(tree: Tree, pos: number, side: -1 | 1): SyntaxNode | null {
  let node: SyntaxNode = tree.resolve(pos, side)
  while (node.parent?.parent) node = node.parent
  if (node.parent) return node
  return side < 0 ? node.childBefore(pos) : node.childAfter(pos)
}

/**
 * Renumbers the numbered lists that hold a changed line (a line number in
 * the old document), in the document after the first edits. A list keeps
 * the number of its first item unless that item is new; the rest count up
 * from it. Children of items whose number grows or shrinks a digit move
 * with it. Only the stretch of top-level blocks around the changes is parsed.
 */
function renumber(cx: Cx, first: ChangeSet, changed: Set<number>): ChangeSet | null {
  const old = cx.state.doc
  const doc = first.apply(old)
  // The changed lines in the new document, which may have more lines.
  const now = new Set([...changed].map((n) => doc.lineAt(first.mapPos(old.line(n).from, 1)).number))
  const numbers = [...now].sort((a, b) => a - b)
  const oldNumbers = [...changed].sort((a, b) => a - b)
  const firstLine = oldNumbers[0]
  const lastLine = oldNumbers.at(-1)
  if (firstLine === undefined || lastLine === undefined) return null
  // A changed line after the last block (an empty last line) has none at or
  // after it: the nearest block on the other side bounds the stretch instead
  // of the start of the note.
  const startPos = old.line(firstLine).from
  const endPos = old.line(lastLine).to
  const start = topBlock(cx.tree, startPos, 1) ?? topBlock(cx.tree, startPos, -1)
  const end = topBlock(cx.tree, endPos, -1) ?? topBlock(cx.tree, endPos, 1)
  const fromPos = Math.min(start?.prevSibling?.from ?? start?.from ?? 0, old.line(firstLine).from)
  const toPos = Math.max(end?.nextSibling?.to ?? end?.to ?? old.length, old.line(lastLine).to)
  let from = doc.lineAt(first.mapPos(old.lineAt(fromPos).from, -1)).from
  const to = doc.lineAt(first.mapPos(old.lineAt(toPos).to, 1)).to
  // Front matter (which the edits may have closed) is read only from the start
  // of a note; a stretch after it is plain GFM.
  if (mayBeFrontMatter(doc, from)) from = 0
  const tree = (from === 0 ? noteParser : markdownLanguage.parser).parse(doc.sliceString(from, to))

  // The numbered lists a changed line belongs to, by the item it is in.
  const touched = new Set<number>()
  for (const n of numbers) {
    const line = doc.line(n)
    if (line.from < from || line.to > to) continue
    const text = line.from + textStart(line) - from
    for (let p: SyntaxNode | null = tree.resolveInner(text, 1); p; p = p.parent) {
      if (p.name !== 'ListItem') continue
      if (p.parent?.name === 'OrderedList') touched.add(p.parent.from)
      break
    }
  }
  if (touched.size === 0) return null

  const edits = new Edits()
  const shifts = new Shifts()
  tree.iterate({
    enter(node) {
      if (node.name !== 'OrderedList' || !touched.has(node.from)) return
      const items = node.node.getChildren('ListItem')
      let next = 0
      items.forEach((item, i) => {
        const mark = item.getChild('ListMark')
        if (!mark) return
        const digits = doc.sliceString(from + mark.from, from + mark.to - 1)
        if (i === 0) next = now.has(doc.lineAt(from + item.from).number) ? 1 : Number(digits)
        const want = String(Math.min(next++, 999_999_999))
        if (want === digits) return
        edits.add(from + mark.from, from + mark.from + digits.length, want)
        const itemLine = doc.lineAt(from + item.from)
        shifts.children(
          doc,
          { from: from + item.from, to: from + item.to },
          quotePrefix(itemLine.text).count,
          want.length - digits.length,
        )
      })
    },
  })
  shifts.into(edits, doc)
  return edits.empty ? null : edits.changes(doc)
}

/**
 * Numbers the items of a numbered list that follow an item leaving it from 1
 * again: they start a list of their own (and only a list starting at 1 can
 * follow a paragraph). Items before the first gap keep their numbers.
 */
function restartAfterGaps(
  doc: Text,
  list: SyntaxNode,
  changed: Set<number>,
  edits: Edits,
  shifts: Shifts,
) {
  let next = 0
  for (const item of list.getChildren('ListItem')) {
    const line = doc.lineAt(item.from)
    if (changed.has(line.number)) {
      next = 1
      continue
    }
    const mark = item.getChild('ListMark')
    if (next === 0 || !mark) continue
    const digits = doc.sliceString(mark.from, mark.to - 1)
    const want = String(next++)
    if (want === digits) continue
    edits.add(mark.from, mark.from + digits.length, want)
    shifts.children(doc, item, quotePrefix(line.text).count, want.length - digits.length)
  }
}

/** The quote markers of a line's kept prefix, up to its last `>`: the start of a blank line next to it. */
function keptQuotes(kept: string): string {
  const quotes = kept.slice(0, quotePrefix(kept).length)
  return quotes.slice(0, quotes.lastIndexOf('>') + 1)
}

/**
 * Sets lines `first` to `last`, which leave a quote or a list, apart from
 * the block above them: they would otherwise continue its paragraph lazily
 * and stay in it. A blank line goes before them, and after them when the
 * block goes on below (`goesOn`), so they are a paragraph of their own.
 */
function setApart(
  edits: Edits,
  doc: Text,
  lines: { first: number; last: number },
  quotes: string,
  goesOn: boolean,
) {
  const above = doc.line(lines.first - 1)
  edits.add(above.to, above.to, `\n${quotes}`)
  if (!goesOn) return
  const below = doc.line(lines.last + 1)
  edits.add(below.from, below.from, `${quotes}\n`)
}

/** The paragraph that the end of line `n` is in. */
function paragraphAtEnd(cx: Cx, n: number): SyntaxNode | null {
  if (n < 1) return null
  const line = cx.state.doc.line(n)
  if (isBlank(line.text)) return null
  for (
    let p: SyntaxNode | null = nodeAt(cx, line.from + line.text.trimEnd().length - 1);
    p;
    p = p.parent
  )
    if (PARAGRAPHS.has(p.name)) return p
  return null
}

/**
 * Whether a line that stops being an item of `list` would continue the
 * paragraph on line `n` above it lazily: that paragraph is in `list`, inside
 * an item that stays (or a quote in one).
 */
function continuesInList(cx: Cx, n: number, list: SyntaxNode, changed: Set<number>): boolean {
  const para = paragraphAtEnd(cx, n)
  if (!para || para.from < list.from || para.to > list.to) return false
  for (let p = para.parent; p && !(p.name === list.name && p.from === list.from); p = p.parent) {
    if (p.name === 'Blockquote') return true
    if (p.name === 'ListItem' && !changed.has(cx.state.doc.lineAt(p.from).number)) return true
  }
  return false
}

/** Sets the lines that stop being items apart from the list items above them. */
function setApartFromList(cx: Cx, lines: ListLine[], changed: Set<number>, edits: Edits) {
  const { doc } = cx.state
  const byLine = new Map(lines.map((l) => [l.line.number, l]))
  for (const l of lines) {
    const n = l.line.number
    const list = l.item?.parent
    if (!list || changed.has(n - 1) || !continuesInList(cx, n - 1, list, changed)) continue
    // The lines leaving with it: its item's, and those of the items right after it.
    let last = n
    for (;;) {
      const item = byLine.get(last)?.item
      if (item) last = Math.max(last, doc.lineAt(item.to).number)
      if (!changed.has(last + 1)) break
      last++
    }
    const below = last < doc.lines ? doc.line(last + 1) : null
    const goesOn = !!below && !isBlank(below.text) && below.to <= list.to
    const kept = l.line.text.slice(0, l.at - l.line.from)
    setApart(edits, doc, { first: n, last }, keptQuotes(kept), goesOn)
  }
}

/**
 * Escapes text at `at` that looks like a list marker but is not one (`2020.`
 * on a paragraph's second line, a lone `+`): as an item's text it would be
 * read as a marker, a list nested in the item. A task's text comes after its
 * box, where no marker is read.
 */
function escapeMarkerText(doc: Text, at: number, edits: Edits) {
  const m = MARKER.exec(doc.sliceString(at, doc.lineAt(at).to))
  if (m) edits.add(at + (m[2]?.length ?? 0), at + (m[2]?.length ?? 0), '\\')
}

/**
 * Makes the selected lines items of `kind`; when they all are already, they
 * stop being items. Items of another kind are converted. An item's children
 * move with it when its marker gets wider or narrower, so nesting is kept,
 * and numbered lists that gain or lose items are renumbered.
 */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec | null {
  const cx = commandContext(state)
  if (!cx) return null
  const lines = listLines(cx)
  if (lines.length === 0) return null
  const remove = listActive(lines, kind)
  const edits = new Edits()
  const shifts = new Shifts()
  const changed = new Set<number>()
  // Lines that become items keep their own indent, also under an item that moves.
  const created = new Set<number>()
  // The delimiter of the numbered list each marker position continues.
  const delims = new Map<string, string | undefined>()
  // Numbered lists that lose an item, by their start.
  const losing = new Map<number, SyntaxNode>()
  const bullet = state.facet(listBullet)
  for (const l of lines) {
    const key = slot(l)
    if (!delims.has(key)) delims.set(key, delimAbove(cx, l))
    if (!remove && kindOf(l.marker) === kind) {
      delims.set(key, l.marker?.delim)
      continue
    }
    const next = remove
      ? { text: '', offset: 0 }
      : newMarker(l.marker, kind, delims.get(key) ?? '.', bullet)
    delims.set(key, remove ? undefined : /[.)](?= $)/.exec(next.text)?.[0])
    edits.add(l.at, l.marker?.textFrom ?? l.at, next.text)
    if (!remove && !l.marker && kind !== 'task') escapeMarkerText(state.doc, l.at, edits)
    changed.add(l.line.number)
    if (!l.item) created.add(l.line.number)
    const list = l.item?.parent
    if (list?.name === 'OrderedList' && l.marker?.number && !l.marker.task)
      losing.set(list.from, list)
    if (l.item && l.marker)
      shifts.children(state.doc, l.item, l.quotes, next.offset - l.marker.offset)
  }
  for (const list of losing.values()) restartAfterGaps(state.doc, list, changed, edits, shifts)
  if (remove) setApartFromList(cx, lines, changed, edits)
  shifts.into(edits, state.doc, created)
  const first = edits.changes(state.doc)
  const second = renumber(cx, first, changed)
  const changes = second ? first.compose(second) : first
  return spec(changes, mapSelection(state, changes))
}

// Quotes and alerts

/**
 * Where a line's quote marker is (or goes) and what it belongs to. A line
 * that continues a list item, or is an item nested in one, is quoted inside
 * that item (after its indent), unless the item's own line is selected too:
 * then the whole item is quoted from the item's line.
 */
interface QuoteLine {
  line: Line
  /** Where the line's quote marker goes. */
  base: number
  /** The item the quote is inside of (its start), or -1 at the top level. */
  owner: number
  /** The line's quote marker at `base`, when it has one. */
  mark: { from: number; to: number } | null
  blank: boolean
  /** Inside fenced code or another literal block. */
  code: boolean
  /** Quoted along with the list item it is in, whose line is selected. */
  withItem: boolean
}

/** The list item a line is in that starts on an earlier line, if any. */
function outerItem(cx: Cx, line: Line): SyntaxNode | null {
  for (let p: SyntaxNode | null = nodeAt(cx, line.from + textStart(line)); p; p = p.parent)
    if (p.name === 'ListItem' && p.from < line.from) return p
  return null
}

/** The column (an offset in its first line) where a list item's text starts. */
function itemTextColumn(doc: Text, item: SyntaxNode): number {
  const line = doc.lineAt(item.from)
  return item.from - line.from + (parseMarker(line, item.from)?.offset ?? 0)
}

const quoteLineCache = new WeakMap<Cx, Map<number, QuoteLine>>()

function quoteLine(cx: Cx, n: number, selected: Set<number>): QuoteLine {
  let known = quoteLineCache.get(cx)
  if (!known) quoteLineCache.set(cx, (known = new Map()))
  const cached = known.get(n)
  if (cached) return cached
  const { doc } = cx.state
  const line = doc.line(n)
  const item = outerItem(cx, line)
  let base = line.from
  let owner = -1
  let withItem = false
  if (item) {
    const itemLine = doc.lineAt(item.from)
    withItem = selected.has(itemLine.number)
    if (withItem) {
      // Quoted along with its item: at the column the item's line is quoted at.
      const outer = quoteLine(cx, itemLine.number, selected)
      let i = 0
      while (i < outer.base - itemLine.from && /[ \t>]/.test(line.text.charAt(i))) i++
      base = line.from + i
      owner = outer.owner
    } else {
      const column = itemTextColumn(doc, item)
      let i = quotePrefix(line.text, quotePrefix(itemLine.text).count).length
      while (i < column && line.text.charAt(i) === ' ') i++
      base = line.from + i
      owner = item.from
    }
  }
  const m = QUOTE_MARK.exec(line.text.slice(base - line.from))
  let mark: QuoteLine['mark'] = null
  if (m) {
    const at = base + m[0].indexOf('>')
    // A marker in the item's text is a quote inside the item, not one around it.
    const outside = !item || owner === item.from || at - line.from < itemTextColumn(doc, item)
    if (outside && nodeAt(cx, at).name === 'QuoteMark')
      mark = { from: base, to: base + m[0].length }
  }
  // Code is judged by the text after the quote marker: code inside a quote is still code.
  let text = mark?.to ?? base
  while (text < line.to && /[ \t]/.test(doc.sliceString(text, text + 1))) text++
  const result: QuoteLine = {
    line,
    base,
    owner,
    mark,
    blank: text === line.to,
    code: inCode(cx, text),
    withItem,
  }
  known.set(n, result)
  return result
}

/**
 * The selected line numbers for the quote formats. A setext heading is taken
 * whole, so its underline stays with its text, and a list item with its
 * children, so they stay in it.
 */
function quoteSelection(cx: Cx): Set<number> {
  const { doc } = cx.state
  const numbers = new Set(selectedLines(cx.state))
  const take = (node: SyntaxNode) => {
    const last = doc.lineAt(node.to).number
    for (let k = doc.lineAt(node.from).number; k <= last; k++) numbers.add(k)
  }
  for (const n of [...numbers]) {
    const line = doc.line(n)
    const node = nodeAt(cx, line.from + textStart(line))
    if (node.name === 'ListMark' && node.parent) take(node.parent)
    for (let p: SyntaxNode | null = node; p; p = p.parent)
      if (p.name.startsWith('SetextHeading')) {
        take(p)
        break
      }
  }
  return new Set([...numbers].sort((a, b) => a - b))
}

/**
 * The selected lines the quote formats work on, and those they count. Lines
 * of literal blocks are left alone, unless they go with their list item: the
 * quote marker goes before the item's indent, so their text stays as it is.
 */
function quoteSelected(cx: Cx): { all: QuoteLine[]; counted: QuoteLine[]; selected: Set<number> } {
  const selected = quoteSelection(cx)
  const all = [...selected]
    .map((n) => quoteLine(cx, n, selected))
    .filter((q) => !q.code || q.withItem)
  return { all, counted: all.filter((q) => !q.blank || selected.size === 1), selected }
}

interface Run {
  first: number
  last: number
}

/** The lines around `n` that `quoted` says are quoted, as one run. */
function runAround(doc: Text, n: number, quoted: (n: number) => boolean): Run {
  let first = n
  while (first > 1 && quoted(first - 1)) first--
  let last = n
  while (last < doc.lines && quoted(last + 1)) last++
  return { first, last }
}

/** Whether line `n` is quoted in the same place as `q` (one quote with it). */
const quotedLike = (cx: Cx, q: QuoteLine, selected: Set<number>) => (n: number) => {
  const other = quoteLine(cx, n, selected)
  return (
    !!other.mark && other.owner === q.owner && other.base - other.line.from === q.base - q.line.from
  )
}

const runs = new WeakMap<Cx, Map<number, Run>>()

/** The quote a quoted line is part of (consecutive lines quoted alike), found once per run. */
function quoteRun(cx: Cx, q: QuoteLine, selected: Set<number>): Run {
  let known = runs.get(cx)
  if (!known) runs.set(cx, (known = new Map()))
  let run = known.get(q.line.number)
  if (!run) {
    run = runAround(cx.state.doc, q.line.number, quotedLike(cx, q, selected))
    for (let i = run.first; i <= run.last; i++) known.set(i, run)
  }
  return run
}

function alertOf(cx: Cx, run: Run, selected: Set<number>): AlertKind | null {
  const q = quoteLine(cx, run.first, selected)
  const m = ALERT_LINE.exec(q.line.text.slice(q.base - q.line.from))
  return m?.[1] ? (m[1].toLowerCase() as AlertKind) : null
}

/** The alert kind of each counted line: null for plain quotes, undefined for unquoted lines. */
function lineAlerts(
  cx: Cx,
  lines: QuoteLine[],
  selected: Set<number>,
): (AlertKind | null | undefined)[] {
  return lines.map((q) => (q.mark ? alertOf(cx, quoteRun(cx, q, selected), selected) : undefined))
}

/** Deletes a run's alert line; a run of that line alone keeps its quote marker. */
function dropAlertLine(cx: Cx, run: Run, selected: Set<number>, edits: Edits) {
  const q = quoteLine(cx, run.first, selected)
  if (run.last > run.first) edits.add(q.line.from, q.line.to + 1)
  else edits.add(q.mark?.to ?? q.base, q.line.to)
}

/** The distinct runs of counted, quoted lines. */
function countedRuns(cx: Cx, lines: QuoteLine[], selected: Set<number>): Run[] {
  const found = new Map<number, Run>()
  for (const q of lines)
    if (q.mark) {
      const run = quoteRun(cx, q, selected)
      found.set(run.first, run)
    }
  return [...found.values()]
}

/**
 * The unquoted lines a quote or alert takes in: the counted ones, and blank
 * lines between them so the quote stays one block.
 */
function linesToQuote(lines: { all: QuoteLine[]; counted: QuoteLine[] }): QuoteLine[] {
  const first = lines.counted[0]?.line.number ?? 0
  const last = lines.counted.at(-1)?.line.number ?? 0
  return lines.all.filter(
    (q) =>
      !q.mark &&
      (lines.counted.includes(q) || (q.blank && q.line.number > first && q.line.number < last)),
  )
}

/** A blank line between quoted ones gets a bare marker; a line alone is typed into. */
const quoteInsert = (q: QuoteLine, alone: boolean) => (q.blank && !alone ? '>' : '> ')

/** Whether a quoted line's text continues a paragraph that starts on a line above it. */
function continuesAbove(cx: Cx, q: QuoteLine): boolean {
  if (!q.mark || q.blank) return false
  let text = q.mark.to
  while (/[ \t]/.test(cx.state.doc.sliceString(text, text + 1))) text++
  for (let p: SyntaxNode | null = nodeAt(cx, text); p; p = p.parent)
    if (PARAGRAPHS.has(p.name)) return p.from < q.line.from
  return false
}

/**
 * Takes the quote markers off `lines`. Lines that would continue a
 * paragraph of the quote above them lazily are set apart from it.
 */
function unquote(cx: Cx, lines: QuoteLine[], selected: Set<number>, edits: Edits) {
  const { doc } = cx.state
  const removed = new Set(lines.filter((q) => q.mark).map((q) => q.line.number))
  for (const q of lines) {
    if (!q.mark) continue
    edits.add(q.mark.from, q.mark.to)
    const n = q.line.number
    if (removed.has(n - 1) || !continuesAbove(cx, q)) continue
    let last = n
    while (removed.has(last + 1)) last++
    const below = last < doc.lines ? doc.line(last + 1) : null
    const goesOn = !!below && !isBlank(below.text) && quotedLike(cx, q, selected)(below.number)
    const { text, from } = q.line
    const kept = text.slice(0, q.base - from) + text.slice(q.mark.to - from)
    setApart(edits, doc, { first: n, last }, keptQuotes(kept), goesOn)
  }
}

/**
 * Quotes the selected lines; when they are all in a plain quote already,
 * takes their quote markers off. Alerts become plain quotes.
 */
export function toggleQuote(state: EditorState): TransactionSpec | null {
  const cx = commandContext(state)
  if (!cx) return null
  const lines = quoteSelected(cx)
  if (lines.counted.length === 0) return null
  const alerts = lineAlerts(cx, lines.counted, lines.selected)
  const edits = new Edits()
  if (alerts.every((a) => a === null)) unquote(cx, lines.all, lines.selected, edits)
  else {
    const alone = lines.all.length === 1
    for (const q of linesToQuote(lines)) edits.add(q.base, q.base, quoteInsert(q, alone))
    for (const run of countedRuns(cx, lines.counted, lines.selected))
      if (alertOf(cx, run, lines.selected)) dropAlertLine(cx, run, lines.selected, edits)
  }
  const changes = edits.changes(state.doc)
  return spec(changes, mapSelection(state, changes))
}

/**
 * Puts the selected lines in an alert of `kind`: unquoted lines are quoted,
 * and the quote they end up in gets the alert line (`> [!NOTE]`) or has its
 * kind changed. When they are all in alerts of that kind, those alerts are
 * removed as a whole: their alert line and every line's quote marker.
 */
export function toggleAlert(state: EditorState, kind: AlertKind): TransactionSpec | null {
  const cx = commandContext(state)
  if (!cx) return null
  const { doc } = state
  const lines = quoteSelected(cx)
  const { selected } = lines
  if (lines.counted.length === 0) return null
  const edits = new Edits()
  if (lineAlerts(cx, lines.counted, selected).every((a) => a === kind)) {
    for (const run of countedRuns(cx, lines.counted, selected)) {
      const marker = doc.line(run.first)
      if (run.last > run.first) edits.add(marker.from, marker.to + 1)
      else edits.add(marker.from, marker.to)
      for (let n = run.first + 1; n <= run.last; n++) {
        const mark = quoteLine(cx, n, selected).mark
        if (mark) edits.add(mark.from, mark.to)
      }
    }
  } else {
    const added = linesToQuote(lines)
    const newly = new Set(added.map((q) => q.line.number))
    const label = `[!${kind.toUpperCase()}]`
    const done = new Set<number>()
    for (const q of lines.counted) {
      const old = quotedLike(cx, q, selected)
      const run = runAround(doc, q.line.number, (n) => newly.has(n) || old(n))
      if (done.has(run.first)) continue
      done.add(run.first)
      const first = quoteLine(cx, run.first, selected)
      const current = old(run.first) ? alertOf(cx, run, selected) : null
      if (current && current !== kind) {
        const at = first.line.from + first.line.text.indexOf('[!', first.base - first.line.from)
        edits.add(at, at + current.length + 3, label)
      } else if (!current) {
        const prefix = first.line.text.slice(0, first.base - first.line.from)
        edits.add(first.line.from, first.line.from, `${prefix}> ${label}\n`)
      }
      // Alerts the new lines join to this one lose their own alert line.
      for (let n = run.first + 1; n <= run.last; n++) {
        if (!old(n) || old(n - 1)) continue
        const line = quoteLine(cx, n, selected)
        if (ALERT_LINE.test(line.line.text.slice(line.base - line.line.from)))
          edits.add(doc.line(n - 1).to, line.line.to)
      }
    }
    const alone = lines.all.length === 1
    for (const q of added) edits.add(q.base, q.base, quoteInsert(q, alone))
  }
  const changes = edits.changes(doc)
  return spec(changes, mapSelection(state, changes))
}

/** The alert kind the whole selection is in, if it is one kind. */
export function alertKind(state: EditorState): AlertKind | null {
  const cx = context(state, TOOLBAR_PARSE_MS)
  if (!cx) return null
  const lines = quoteSelected(cx)
  const kinds = new Set(lineAlerts(cx, lines.counted, lines.selected))
  const [only] = kinds
  return kinds.size === 1 && only ? only : null
}

// Code blocks

/** The fenced code block a line is part of, if any. */
function fenceOf(cx: Cx, line: Line): SyntaxNode | null {
  const at = line.from + containerEnd(cx, line)
  for (let n: SyntaxNode | null = nodeAt(cx, at); n; n = n.parent)
    if (n.name === 'FencedCode') return n.from <= line.to && n.to >= line.from ? n : null
  return null
}

/**
 * The block a fence must not cut into, when a line is part of one: fenced
 * code (its fences would pair up wrongly), a setext heading (its underline
 * would be left behind) or indented code (it is wrapped whole).
 */
function wholeBlock(cx: Cx, line: Line): SyntaxNode | null {
  const fence = fenceOf(cx, line)
  if (fence) return fence
  if (isBlank(line.text)) return null
  for (let n: SyntaxNode | null = nodeAt(cx, line.from + textStart(line)); n; n = n.parent)
    if (n.name.startsWith('SetextHeading') || n.name === 'CodeBlock') return n
  return null
}

/**
 * Where the text of the indented code block a line is in starts: a column
 * after `quotes` quote markers. Null when the line is not indented code.
 */
function indentedCodeColumn(cx: Cx, line: Line, quotes: number): number | null {
  if (isBlank(line.text)) return null
  for (let n: SyntaxNode | null = nodeAt(cx, line.from + textStart(line)); n; n = n.parent) {
    if (n.name !== 'CodeBlock') continue
    const first = cx.state.doc.lineAt(n.from)
    return n.from - first.from - quotePrefix(first.text, quotes).length
  }
  return null
}

function codeLines(cx: Cx): { line: Line; fence: SyntaxNode | null; blank: boolean }[] {
  const numbers = selectedLines(cx.state).filter(
    (n) => !inFrontMatter(cx, cx.state.doc.line(n).from),
  )
  const lines = numbers.map((n) => {
    const line = cx.state.doc.line(n)
    return { line, fence: fenceOf(cx, line), blank: isBlank(line.text) }
  })
  const counted = lines.filter((l) => !l.blank)
  return counted.length > 0 ? counted : lines
}

/**
 * The column (after `quotes` characters of quote markers) where the text of
 * the list item a line continues starts; null when it continues none.
 */
function itemColumn(cx: Cx, line: Line, quotes: number): number | null {
  const item = outerItem(cx, line)
  return item ? itemTextColumn(cx.state.doc, item) - quotes : null
}

/**
 * The column (after `quotes` characters of quote markers) of the text of the
 * list item an indented blank line continues, found from the lines above it:
 * the innermost item that ends there, in the quotes the line is in, whose
 * text starts at or before the line's own indent. A blank line at the end of an item is outside it for
 * the parser, so the item cannot be read from the line itself.
 */
function itemAbove(cx: Cx, line: Line, quotes: number, indent: number): number | null {
  const { doc } = cx.state
  let n = line.number - 1
  while (n >= 1 && isBlank(doc.line(n).text)) n--
  if (n < 1) return null
  // The line goes on in the quotes it has markers of; an item in another quote ended above it.
  const depth = quotePrefix(line.text.slice(0, quotes)).count
  for (let p: SyntaxNode | null = cx.tree.resolveInner(doc.line(n).to, -1); p; p = p.parent) {
    if (p.name !== 'ListItem' || quoteDepth(p) !== depth) continue
    const column = itemTextColumn(doc, p) - quotes
    if (column <= indent) return column
  }
  return null
}

/** How many quotes a node is in. */
function quoteDepth(node: SyntaxNode): number {
  let depth = 0
  for (let p = node.parent; p; p = p.parent) if (p.name === 'Blockquote') depth++
  return depth
}

/**
 * The fence of a code block made in an empty list item (`2. `, `- `): it
 * goes in the item, after the marker, and its text lines up with the item's
 * text; a task item's box has no fence after it, so the fence goes under it.
 * Null when the selection is not just such an item.
 */
function emptyItemFence(cx: Cx): TransactionSpec | null {
  const { state } = cx
  const { doc } = state
  const spans = wrapSpans(cx)
  const first = spans[0]
  if (state.selection.ranges.length !== 1 || spans.length !== 1 || !first || first[0] !== first[1])
    return null
  const line = doc.line(first[0])
  const role = listRole(cx, line.number)
  if (role === 'skip' || !role.item || !role.marker || role.marker.textFrom !== line.to) return null
  const quotes = line.text.slice(0, quotePrefix(line.text).length)
  const column = role.at - line.from + role.marker.offset
  const indent = quotes + ' '.repeat(Math.max(0, column - quotes.length))
  const fence = '```'
  const inside = `\n${indent}\n${indent}${fence}`
  if (role.marker.task) {
    const open = `\n${indent}${fence}`
    const changes = state.changes({ from: line.to, insert: open + inside })
    return spec(changes, EditorSelection.single(line.to + open.length + 1 + indent.length))
  }
  // The marker keeps one space before the fence (an empty item's offset counts it).
  const end = role.at + role.marker.offset - 1
  const changes = state.changes({ from: end, to: line.to, insert: ` ${fence}${inside}` })
  return spec(changes, EditorSelection.single(end + 1 + fence.length + 1 + indent.length))
}

/** Takes the fences off a block, keeping its text where it was. */
function unwrap(doc: Text, block: SyntaxNode, edits: Edits) {
  const marks = block.getChildren('CodeMark')
  const open = marks[0]
  if (!open) return
  const close = marks.length > 1 ? marks.at(-1) : undefined
  const line = doc.lineAt(open.from)
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null
  if (/^[ \t>]*$/.test(doc.sliceString(line.from, open.from))) {
    // The fence has a line of its own.
    if (next) edits.add(line.from, next.from)
    else edits.add(Math.max(0, line.from - 1), line.to)
  } else if (next) {
    // The fence follows a list marker: the block's first line takes its place.
    const column = open.from - line.from
    let indent = 0
    while (indent < column && /[ \t>]/.test(next.text.charAt(indent))) indent++
    edits.add(open.from, next.from + indent)
  } else edits.add(open.from, line.to)
  if (close) {
    const closing = doc.lineAt(close.from)
    if (closing.number > line.number) edits.add(closing.from - 1, closing.to)
  }
}

/**
 * Wraps the selected lines in a fenced code block; when they are all in
 * fenced code already, takes the fences of those blocks off. The fence is
 * longer than any fence among the lines, and goes inside the quote they share.
 * Indented code loses the indent that made it code, so its text is kept.
 */
export function toggleCodeBlock(state: EditorState): TransactionSpec | null {
  const cx = commandContext(state)
  if (!cx) return null
  const { doc } = state
  const lines = codeLines(cx)
  if (lines.length === 0) return null
  if (lines.every((l) => l.fence)) {
    const edits = new Edits()
    const blocks = new Map(lines.map((l) => [l.fence?.from, l.fence]))
    for (const block of blocks.values()) if (block) unwrap(doc, block, edits)
    const changes = edits.changes(doc)
    return spec(changes, mapSelection(state, changes))
  }
  const inItem = emptyItemFence(cx)
  if (inItem) return inItem
  const opens = new Edits()
  const closes: { at: number; insert: string }[] = []
  for (const [first, last] of wrapSpans(cx)) {
    const firstLine = doc.line(first)
    let depth = Infinity
    for (let n = first; n <= last; n++) depth = Math.min(depth, quotePrefix(doc.line(n).text).count)
    let longest = 0
    let indent = Infinity
    // The column the text of each line of indented code starts at.
    const code = new Map<number, number>()
    for (let n = first; n <= last; n++) {
      const line = doc.line(n)
      const rest = line.text.slice(quotePrefix(line.text, depth).length)
      longest = Math.max(longest, LEADING_FENCE.exec(rest)?.[1]?.length ?? 0)
      const column = indentedCodeColumn(cx, line, depth)
      if (column !== null) code.set(n, column)
      // Indented code sits four columns in from the block it is in.
      if (column !== null) indent = Math.min(indent, Math.max(0, column - 4))
      else if (!isBlank(rest)) indent = Math.min(indent, /^ */.exec(rest)?.[0].length ?? 0)
    }
    const quotes = quotePrefix(firstLine.text, depth).length
    // The fence goes in as far as the lines, up to the text of the item they continue.
    let reach = itemColumn(cx, firstLine, quotes)
    if (!Number.isFinite(indent)) {
      // Blank lines only: as far as the first is indented, if that is into an item above it.
      indent = /^ */.exec(firstLine.text.slice(quotes))?.[0].length ?? 0
      reach ??= itemAbove(cx, firstLine, quotes, indent)
    }
    indent = Math.min(indent, reach ?? 3)
    const fence =
      firstLine.text.slice(0, quotes) + ' '.repeat(indent) + '`'.repeat(Math.max(3, longest + 1))
    opens.add(firstLine.from, firstLine.from, `${fence}\n`)
    closes.push({ at: doc.line(last).to, insert: `\n${fence}` })
    // Inside the fence, a line loses as many spaces as the fence has.
    for (const [n, column] of code) {
      const line = doc.line(n)
      const from = line.from + quotePrefix(line.text, depth).length
      let end = from
      while (end - from < column - indent && /[ \t]/.test(doc.sliceString(end, end + 1))) end++
      opens.add(from, end)
    }
  }
  // In two steps, so a cursor on an empty line ends up between the fences.
  const open = opens.changes(doc)
  const close = ChangeSet.of(
    closes.map((c) => ({ from: open.mapPos(c.at, 1), insert: c.insert })),
    open.newLength,
  )
  return spec(open.compose(close), mapSelection(state, open, close))
}

/**
 * The stretches of lines each range wraps, as [first, last] line numbers:
 * its lines without blank ones at the edges or front matter, widened over
 * any fenced block (a fence inside must be closed inside), setext heading or
 * indented code they cut into.
 * Stretches that meet become one.
 */
function wrapSpans(cx: Cx): [number, number][] {
  const { state } = cx
  const { doc } = state
  const spans: [number, number][] = []
  for (const range of state.selection.ranges) {
    const numbers = rangeLines(state, range).filter((n) => !inFrontMatter(cx, doc.line(n).from))
    if (numbers.length === 0) continue
    const filled = numbers.filter((n) => !isBlank(doc.line(n).text))
    let first = filled[0] ?? numbers[0] ?? 1
    let last = filled.at(-1) ?? numbers.at(-1) ?? first
    const top = wholeBlock(cx, doc.line(first))
    if (top) first = doc.lineAt(top.from).number
    const bottom = wholeBlock(cx, doc.line(last))
    if (bottom) last = doc.lineAt(bottom.to).number
    spans.push([first, last])
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of spans) {
    const prev = merged.at(-1)
    if (prev && span[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], span[1])
    else merged.push([...span])
  }
  return merged
}

// Toolbar state

export type BlockState = Record<BlockFormat, boolean>

export const NO_BLOCKS: BlockState = {
  codeBlock: false,
  bulletList: false,
  numberedList: false,
  taskList: false,
  quote: false,
  alert: false,
}

/** Which block formats the selection has (the pressed buttons). */
export function blockState(state: EditorState): BlockState {
  const cx = context(state, TOOLBAR_PARSE_MS)
  return cx ? blockStateOf(cx) : NO_BLOCKS
}

/** `blockState` for a context the toolbar already has. */
export function blockStateOf(cx: Cx): BlockState {
  if (!toolbarReads(cx.state)) return NO_BLOCKS
  const lists = listLines(cx)
  const quotes = quoteSelected(cx)
  const alerts = lineAlerts(cx, quotes.counted, quotes.selected)
  const code = codeLines(cx)
  return {
    codeBlock: code.length > 0 && code.every((l) => l.fence),
    bulletList: listActive(lists, 'bullet'),
    numberedList: listActive(lists, 'numbered'),
    taskList: listActive(lists, 'task'),
    quote: alerts.length > 0 && alerts.every((a) => a === null),
    alert: alerts.length > 0 && alerts.every((a) => !!a),
  }
}
