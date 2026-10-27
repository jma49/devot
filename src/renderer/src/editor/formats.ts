// Markdown formats as named commands. Each turns an EditorState into one transaction spec (null when
// there is nothing to do): one change set, the new selection, the `input.format` user event and
// isolated history, so Yjs and undo see a single step.
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state'
import { startCompletion } from '@codemirror/autocomplete'
import type { Command } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { editorComposes } from '../ime'
import {
  ALERT_KINDS,
  blockStateOf,
  NO_BLOCKS,
  toggleAlert,
  atNewFence,
  codeBlockCommand,
  toggleList,
  toggleQuote,
  type AlertKind,
  type BlockFormat,
} from './blocks'
import { insertRule } from './rule'
import { Covered, SpanIndex } from './spanIndex'
import {
  alertHeader,
  blockAround,
  containerEnd,
  context,
  inFrontMatter,
  LITERAL_BLOCK_NAMES,
  LITERAL_BLOCKS,
  nodeAt,
  rangeLines,
  spec,
  TOOLBAR_PARSE_MS,
  toolbarReads,
  type Cx,
  type FormatCommand,
} from './formatContext'

export { FORMAT_EVENT, type FormatCommand } from './formatContext'

export type InlineFormat = 'bold' | 'italic' | 'strikethrough' | 'highlight' | 'code'
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
export type AlertFormat = `alert${Capitalize<AlertKind>}`

export const alertFormat = (kind: AlertKind): AlertFormat =>
  `alert${kind.charAt(0).toUpperCase()}${kind.slice(1)}` as AlertFormat
export type FormatId =
  | InlineFormat
  | 'link'
  | 'heading'
  | `heading${HeadingLevel}`
  | 'headingBigger'
  | 'headingSmaller'
  | Exclude<BlockFormat, 'alert'>
  | AlertFormat
  | 'horizontalRule'
type Wrap = InlineFormat | 'link'

const INLINE: Record<InlineFormat, { node: string | null; open: string; close: string }> = {
  bold: { node: 'StrongEmphasis', open: '**', close: '**' },
  italic: { node: 'Emphasis', open: '*', close: '*' },
  strikethrough: { node: 'Strikethrough', open: '~~', close: '~~' },
  // The dialect has no `==` syntax; `mark` is on the sanitizer allowlist.
  highlight: { node: null, open: '<mark>', close: '</mark>' },
  code: { node: 'InlineCode', open: '`', close: '`' },
}

const MARK_OPEN = /^<mark(?:\s[^>]*)?>$/i
const MARK_CLOSE = /^<\/mark\s*>$/i
const TASK_BOX = /^\[[ xX]\][ \t]+/
const HEADING_MARKS = /^#{1,6}(?=[ \t]|$)[ \t]*/
const URL_ONLY = /^https?:\/\/\S+$/i

const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n'

/**
 * Where a line's text starts for the inline formats (an offset in the
 * line): after the quote and list markers the syntax tree has there, a
 * heading's #s and a task box. They stay outside the new markers.
 */
function blockPrefix(cx: Cx, line: Line): number {
  const at = containerEnd(cx, line)
  const rest = line.text.slice(at)
  const hashes = HEADING_MARKS.exec(rest)
  if (hashes) return at + hashes[0].length
  const box = TASK_BOX.exec(rest)
  return box && nodeAt(cx, line.from + at).name === 'TaskMarker' ? at + box[0].length : at
}

/** A formatted span: `from`–`openTo` and `closeFrom`–`to` are its markers. */
interface Span {
  from: number
  to: number
  openTo: number
  closeFrom: number
}

interface Syntax extends Span {
  nest: boolean
}

/**
 * A part of one line of a selection range, trimmed of spaces and block
 * markers. `selFrom`–`selTo` is the part the user selected, which may be
 * smaller when the segment was widened over other syntax.
 */
interface Segment {
  from: number
  to: number
  range: number
  selFrom: number
  selTo: number
}

const touches = (span: { from: number; to: number }, from: number, to: number) =>
  span.from <= to && span.to >= from

/** Spans of `format` that touch `from`–`to` (outermost ones only; none for links). */
function spansNear(cx: Cx, format: Wrap, from: number, to: number): Span[] {
  if (format === 'link') return []
  const name = INLINE[format].node
  if (!name) return markSpans(cx, from, to)
  const spans: Span[] = []
  cx.tree.iterate({
    from: Math.max(0, from - 1),
    to: Math.min(cx.state.doc.length, to + 1),
    enter(node) {
      if (node.name !== name) return true
      const first = node.node.firstChild
      const last = node.node.lastChild
      if (first && last && first.from !== last.from && touches(node, from, to))
        spans.push({ from: node.from, to: node.to, openTo: first.to, closeFrom: last.from })
      return false
    },
  })
  return spans
}

function markSpans(cx: Cx, from: number, to: number): Span[] {
  const { state } = cx
  const lineFrom = state.doc.lineAt(from).from
  const lineTo = state.doc.lineAt(to).to
  const spans: Span[] = []
  const open: { from: number; to: number }[] = []
  cx.tree.iterate({
    from: lineFrom,
    to: lineTo,
    enter(node) {
      if (node.name !== 'HTMLTag') return true
      const tag = state.sliceDoc(node.from, node.to)
      if (MARK_OPEN.test(tag)) open.push({ from: node.from, to: node.to })
      else if (MARK_CLOSE.test(tag)) {
        const start = open.pop()
        if (start)
          spans.push({ from: start.from, to: node.to, openTo: start.to, closeFrom: node.from })
      }
      return false
    },
  })
  return spans
    .filter((s) => touches(s, from, to))
    .filter((s, _, all) => !all.some((o) => o !== s && o.from <= s.from && o.to >= s.to))
}

function syntaxMarks(cx: Cx, from: number, to: number): Set<number> {
  const marks = new Set<number>()
  cx.tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name.endsWith('Mark') || node.name === 'HTMLTag')
        for (let p = Math.max(from, node.from); p < Math.min(to, node.to); p++) marks.add(p)
    },
  })
  return marks
}

/**
 * A Markdown link or image: a `Link` node with an address or a reference
 * label. Bracketed text alone (`[draft]`, the inside of `[[Note]]`) also
 * parses as `Link`, but is not one.
 */
function linkOf(node: SyntaxNode): Span | null {
  const marks = node.getChildren('LinkMark')
  const open = marks[0]
  const close = marks[1]
  if (!open || !close) return null
  const real =
    node.name === 'Image' ||
    marks.length > 2 ||
    node.getChild('URL') !== null ||
    node.getChild('LinkLabel') !== null
  return real ? { from: node.from, to: node.to, openTo: open.to, closeFrom: close.from } : null
}

const NESTING_MARKS: Record<string, string> = {
  Emphasis: 'EmphasisMark',
  StrongEmphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
}
// Syntax nothing may be inserted into.
const ATOMIC = new Set(['InlineCode', 'Autolink', 'URL', 'HTMLTag', 'Escape', 'Entity'])

function otherSyntax(cx: Cx, format: Wrap, from: number, to: number): Syntax[] {
  const own = format === 'link' ? undefined : INLINE[format].node
  const found: Syntax[] = []
  cx.tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name === own) return true
      const markName = NESTING_MARKS[node.name]
      if (markName) {
        const marks = node.node.getChildren(markName)
        const first = marks[0]
        const last = marks.at(-1)
        if (first && last && first !== last)
          found.push({
            from: node.from,
            to: node.to,
            openTo: first.to,
            closeFrom: last.from,
            nest: true,
          })
        return true
      }
      if (node.name === 'Link' || node.name === 'Image') {
        const link = linkOf(node.node)
        if (link) found.push({ ...link, nest: true })
        return true
      }
      if (ATOMIC.has(node.name)) {
        const tag = cx.state.sliceDoc(node.from, node.to)
        if (format === 'highlight' && (MARK_OPEN.test(tag) || MARK_CLOSE.test(tag))) return false
        found.push({
          from: node.from,
          to: node.to,
          openTo: node.to,
          closeFrom: node.to,
          nest: false,
        })
        return false
      }
      return true
    },
  })
  if (format !== 'highlight')
    for (const span of markSpans(cx, from, to)) found.push({ ...span, nest: true })
  return found
}

// Syntax whose characters are text of their own: never escaped, never brackets.
const LITERAL = new Set([...ATOMIC, 'LinkLabel', 'LinkTitle'])

function literalChars(cx: Cx, from: number, to: number, marks: boolean): Set<number> {
  const found = new Set<number>()
  cx.tree.iterate({
    from,
    to,
    enter(node) {
      const literal = LITERAL.has(node.name)
      if (literal || (marks && node.name.endsWith('Mark')))
        for (let p = Math.max(from, node.from); p < Math.min(to, node.to); p++) found.add(p)
      return !literal
    },
  })
  return found
}

const SKIPPED_BLOCKS = new Set([...LITERAL_BLOCKS, 'HorizontalRule', 'LinkReference'])

type LineBlock =
  | { kind: 'text' }
  | { kind: 'skip' }
  | { kind: 'table'; cells: { from: number; to: number }[] }

/**
 * What a line belongs to: ordinary text; a table row (only its cells take
 * inline formats); or a block that formats would break (code, thematic
 * breaks, HTML, front matter, a table's delimiter row, a setext underline).
 */
function lineBlock(cx: Cx, line: Line): LineBlock {
  if (inFrontMatter(cx, line.from) || alertHeader(cx, line)) return { kind: 'skip' }
  let at = blockPrefix(cx, line)
  while (at < line.length && isSpace(line.text.charAt(at))) at++
  if (at >= line.length)
    return blockAround(cx, line.from, LITERAL_BLOCK_NAMES) ? { kind: 'skip' } : { kind: 'text' }
  for (let node: SyntaxNode | null = nodeAt(cx, line.from + at); node;) {
    if (SKIPPED_BLOCKS.has(node.name)) return { kind: 'skip' }
    if (node.name === 'HeaderMark' && node.parent?.name.startsWith('SetextHeading'))
      return { kind: 'skip' }
    if (node.parent?.name === 'Table') {
      if (node.name !== 'TableHeader' && node.name !== 'TableRow') return { kind: 'skip' }
      return {
        kind: 'table',
        cells: node.getChildren('TableCell').map((c) => ({ from: c.from, to: c.to })),
      }
    }
    node = node.parent
  }
  return { kind: 'text' }
}

function segmentsOf(cx: Cx, range: SelectionRange, index: number): Segment[] {
  const { state } = cx
  const segments: Segment[] = []
  const add = (lineFrom: number, text: string, partFrom: number, partTo: number) => {
    let from = Math.max(range.from, partFrom)
    let to = Math.min(range.to, partTo)
    while (from < to && isSpace(text.charAt(from - lineFrom))) from++
    while (to > from && isSpace(text.charAt(to - 1 - lineFrom))) to--
    if (from < to) segments.push({ from, to, range: index, selFrom: from, selTo: to })
  }
  for (const n of rangeLines(state, range)) {
    const line = state.doc.line(n)
    const block = lineBlock(cx, line)
    if (block.kind === 'skip') continue
    if (block.kind === 'table') {
      for (const cell of block.cells) add(line.from, line.text, cell.from, cell.to)
      continue
    }
    const prefix = blockPrefix(cx, line)
    add(line.from, line.text, line.from + prefix, line.to)
  }
  return segments
}

const segmentCache = new WeakMap<Cx, Segment[][]>()

/** Each range's segments (none for a cursor), split once per state. */
function rangeSegments(cx: Cx): Segment[][] {
  let segments = segmentCache.get(cx)
  if (!segments) {
    segments = cx.state.selection.ranges.map((range, i) =>
      range.empty ? [] : segmentsOf(cx, range, i),
    )
    segmentCache.set(cx, segments)
  }
  return segments
}

function cursorSkipped(cx: Cx, pos: number): boolean {
  return lineBlock(cx, cx.state.doc.lineAt(pos)).kind === 'skip'
}

/**
 * Is every character of the segment's text inside a span of the format?
 * Punctuation at its edges that the markers could not hold (see `rebuild`)
 * stays outside them, so a segment that includes it has the format when
 * applying it again would change nothing.
 */
function segmentActive(cx: Cx, format: InlineFormat, seg: Segment): boolean {
  const spans = new SpanIndex(spansNear(cx, format, seg.from, seg.to))
  const marks = syntaxMarks(cx, seg.from, seg.to)
  const text = cx.state.sliceDoc(seg.from, seg.to)
  for (let p = seg.from; p < seg.to; p++) {
    if (spans.marker(p)) continue
    if (marks.has(p) || isSpace(text.charAt(p - seg.from))) continue
    if (!spans.inside(p)) return FLANKING.has(format) && unchanged(cx, format, seg)
  }
  return true
}

function unchanged(cx: Cx, format: InlineFormat, part: Segment): boolean {
  const seg = widen(cx, format, part, true)
  const spans = spansNear(cx, format, seg.from, seg.to)
  if (spans.length === 0) return false
  const from = spans.reduce((low, s) => Math.min(low, s.from), seg.from)
  const to = spans.reduce((high, s) => Math.max(high, s.to), seg.to)
  const { text } = rebuild(cx, format, { from, to, spans, segments: [seg] }, true)
  return text === cx.state.sliceDoc(from, to)
}

function spanAtCursor(cx: Cx, format: InlineFormat, pos: number): Span | undefined {
  return spansNear(cx, format, pos, pos).find((s) => s.openTo <= pos && pos <= s.closeFrom)
}

function inlineActive(cx: Cx, format: InlineFormat): boolean {
  let any = false
  for (const [i, range] of cx.state.selection.ranges.entries()) {
    if (range.empty) {
      if (!spanAtCursor(cx, format, range.head)) return false
      any = true
      continue
    }
    for (const seg of rangeSegments(cx)[i] ?? []) {
      if (!segmentActive(cx, format, seg)) return false
      any = true
    }
  }
  return any
}

export function isInlineActive(state: EditorState, format: InlineFormat): boolean {
  const cx = context(state)
  return !!cx && inlineActive(cx, format)
}

/**
 * The character escaped inside a format's markers: a plain `*` in bold or
 * italic text (or `~` in struck text) would otherwise end the span early.
 */
const ESCAPED: Partial<Record<InlineFormat, string>> = {
  bold: '*',
  italic: '*',
  strikethrough: '~',
}

/** Opening and closing markers for this text (code needs a longer fence around backticks). */
function markersFor(format: InlineFormat, text: string): [string, string] {
  if (format !== 'code') return [INLINE[format].open, INLINE[format].close]
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return [fence + pad, pad + fence]
}

interface Region {
  from: number
  to: number
  spans: Span[]
  segments: Segment[]
  cursor?: { range: number; pos: number }
  strip?: boolean
}

interface Rebuilt {
  text: string
  /** New offset (in `text`) of the character at an old position, or of the next one. */
  offsetOf: (pos: number) => number
  /** New offsets around the text (not spaces) of old positions `from`–`to`. */
  rangeOf: (from: number, to: number) => [number, number]
}

// Emphasis markers follow CommonMark's flanking rules: the opening ones need
// a character that is not white space after them, and if that is punctuation,
// white space or punctuation before them; the closing ones the mirror image.
// CJK prose has no spaces, so text ends against punctuation and ideographs.
// The editor's parser (Lezer) counts every symbol as punctuation; the
// preview's (micromark) only the ASCII ones and Unicode's punctuation. Markers
// are written only where both read them the same. Both read the one UTF-16
// unit beside a marker, so half of a character outside the BMP (an emoji) is
// neither white space nor punctuation to them; the characters moved outside
// the markers are still whole.
const FLANKING: ReadonlySet<InlineFormat> = new Set(['bold', 'italic', 'strikethrough'])
const isWhite = (ch: string) => ch === '' || /\s/u.test(ch)
const PUNCTUATION = [
  (ch: string) => /[\p{P}\p{S}]/u.test(ch),
  (ch: string) => /[!-/:-@[-`{-~]/.test(ch) || /\p{P}/u.test(ch),
]
const canOpen = (before: string, after: string) => {
  const [b, a] = [before.slice(-1), after.slice(0, 1)]
  return !isWhite(a) && PUNCTUATION.every((punct) => !punct(a) || isWhite(b) || punct(b))
}
const canClose = (before: string, after: string) => {
  const [b, a] = [before.slice(-1), after.slice(0, 1)]
  return !isWhite(b) && PUNCTUATION.every((punct) => !punct(b) || isWhite(a) || punct(a))
}

/**
 * Rewrites a region: drops the format's markers, decides per character
 * whether it is formatted (applying or removing the format on the
 * segments), then wraps each formatted run in fresh markers, spaces
 * outside. A run with no text of its own (only other syntax) stays plain.
 * Emphasis markers must flank the run (see `canOpen`): punctuation at its
 * edges that would keep them from opening or closing goes outside them, and
 * a run with nothing else stays plain.
 * Inside the markers, plain marker characters (see `ESCAPED`) and a
 * trailing backslash are escaped, so the new span covers the whole run.
 * Escapes stay when the format is removed again: they render the same.
 */
function rebuild(cx: Cx, format: InlineFormat, region: Region, apply: boolean): Rebuilt {
  const { state } = cx
  const others = syntaxMarks(cx, region.from, region.to)
  const literal = format === 'code' ? null : literalChars(cx, region.from, region.to, true)
  const spans = new SpanIndex(region.spans)
  const segments = new Covered(region.segments)
  const old = state.sliceDoc(region.from, region.to)
  const chars: { pos: number; ch: string; on: boolean }[] = []
  for (let pos = region.from; pos < region.to; pos++) {
    if (spans.marker(pos)) continue
    let on = !region.strip && spans.inside(pos)
    if (segments.has(pos)) on = apply
    chars.push({ pos, ch: old.charAt(pos - region.from), on })
  }

  let text = ''
  const offsets = new Map<number, [number, number]>()
  const put = (c: (typeof chars)[number], escape: boolean) => {
    const start = text.length
    if (escape) text += '\\'
    text += c.ch
    offsets.set(c.pos, [start, text.length])
  }
  const plain = (run: typeof chars) => {
    for (const c of run) put(c, false)
  }
  const escapes = (c: (typeof chars)[number], last: boolean) =>
    !!literal && !literal.has(c.pos) && (c.ch === ESCAPED[format] || (last && c.ch === '\\'))
  /** The character beside a position of the document, '' at the edge of a line's text. */
  const around = (pos: number, side: -1 | 1): string => {
    const line = state.doc.lineAt(pos)
    if (side < 0 ? pos <= line.from + blockPrefix(cx, line) : pos >= line.to) return ''
    const near =
      side < 0 ? state.sliceDoc(Math.max(line.from, pos - 2), pos) : state.sliceDoc(pos, pos + 2)
    const ch = (side < 0 ? Array.from(near).at(-1) : Array.from(near)[0]) ?? ''
    // The pipe around a table cell is not text beside the cell's.
    return ch === '|' && lineBlock(cx, line).kind === 'table' ? '' : ch
  }
  const lastOut = () => Array.from(text.slice(-2)).at(-1) ?? ''
  /**
   * How many characters of a run's text go outside its markers at each end
   * so that both can open and close; null when they cannot (a character
   * that is escaped cannot move, and a run of only punctuation has no text).
   */
  const flank = (
    core: typeof chars,
    before: string,
    after: string,
  ): { lead: number; trail: number } | null => {
    let lead = 0
    let trail = 0
    // Whole characters: a surrogate pair is one.
    const glyph = (at: number, side: -1 | 1) => {
      const c = core[at]
      const pair = core[at + side]
      if (!c) return { text: '', size: 0 }
      if (side > 0 && pair && /[\ud800-\udbff]/.test(c.ch) && /[\udc00-\udfff]/.test(pair.ch))
        return { text: c.ch + pair.ch, size: 2 }
      if (side < 0 && pair && /[\udc00-\udfff]/.test(c.ch) && /[\ud800-\udbff]/.test(pair.ch))
        return { text: pair.ch + c.ch, size: 2 }
      return { text: c.ch, size: 1 }
    }
    for (;;) {
      if (lead + trail >= core.length) return null
      const firstAt = lead
      const lastAt = core.length - 1 - trail
      const first = glyph(firstAt, 1)
      const last = glyph(lastAt, -1)
      const firstChar = core[firstAt]
      const lastChar = core[lastAt]
      if (!firstChar || !lastChar) return null
      const beforeCh = lead > 0 ? glyph(lead - 1, -1).text : before
      const afterCh = trail > 0 ? glyph(core.length - trail, 1).text : after
      // Other syntax at an edge (an emphasis marker) is not moved.
      const openText = escapes(firstChar, false) ? '\\' : first.text
      const closeText = last.text
      const opens = others.has(firstChar.pos) || canOpen(beforeCh, openText)
      const closes = others.has(lastChar.pos) || canClose(closeText, afterCh)
      if (opens && closes) return { lead, trail }
      if (!opens) {
        if (escapes(firstChar, false)) return null
        lead += first.size
      } else {
        if (escapes(lastChar, true)) return null
        trail += last.size
      }
    }
  }
  for (let i = 0; i < chars.length;) {
    let j = i
    while (j < chars.length && chars[j]?.on === chars[i]?.on) j++
    const run = chars.slice(i, j)
    i = j
    if (!run[0]?.on || !run.some((c) => !isSpace(c.ch) && !others.has(c.pos))) {
      plain(run)
      continue
    }
    let a = 0
    let b = run.length
    while (isSpace(run[a]?.ch ?? '')) a++
    while (isSpace(run[b - 1]?.ch ?? '')) b--
    const core = run.slice(a, b)
    let lead = 0
    let trail = 0
    if (FLANKING.has(format)) {
      const before =
        a > 0 ? (run[a - 1]?.ch ?? '') : text === '' ? around(region.from, -1) : lastOut()
      const nextChar = b < run.length ? run[b]?.ch : chars[j]?.ch
      const fit = flank(core, before, nextChar ?? around(region.to, 1))
      if (!fit) {
        plain(run)
        continue
      }
      ;({ lead, trail } = fit)
    }
    const held = core.slice(lead, core.length - trail)
    const [open, close] = markersFor(format, held.map((c) => c.ch).join(''))
    plain(run.slice(0, a))
    plain(core.slice(0, lead))
    text += open
    held.forEach((c, k) => put(c, escapes(c, k === held.length - 1)))
    text += close
    plain(core.slice(core.length - trail))
    plain(run.slice(b))
  }
  const indexAt = (pos: number) => {
    let low = 0
    let high = chars.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((chars[mid]?.pos ?? Infinity) < pos) low = mid + 1
      else high = mid
    }
    return low
  }
  const offsetOf = (pos: number) => {
    const next = chars[indexAt(pos)]
    return next ? (offsets.get(next.pos)?.[0] ?? text.length) : text.length
  }
  return {
    text,
    offsetOf,
    rangeOf: (from, to) => {
      const end = indexAt(to)
      let a = indexAt(from)
      let b = end - 1
      while (a < end && isSpace(chars[a]?.ch ?? '')) a++
      while (b >= a && isSpace(chars[b]?.ch ?? '')) b--
      const first = chars[a]
      const last = chars[b]
      if (a >= end || !first || !last) return [offsetOf(from), offsetOf(from)]
      return [offsets.get(first.pos)?.[0] ?? 0, offsets.get(last.pos)?.[1] ?? 0]
    },
  }
}

/**
 * Widens a segment until the new markers nest with the other inline syntax
 * around it. Markers may go inside a nesting node's text (`*a**b**c*`), but
 * a node whose own markers would end up on both sides of a new marker
 * (`**a *b* c**` with the bold taken off `b`, or a selection ending inside
 * a code span) is taken into the segment as a whole.
 */
function widen(cx: Cx, format: Wrap, seg: Segment, apply: boolean): Segment {
  let { from, to } = seg
  const lineFrom = cx.state.doc.lineAt(seg.from).from
  const lineTo = cx.state.doc.lineAt(seg.to).to
  for (;;) {
    const near = spansNear(cx, format, from, to)
    const regionFrom = near.reduce((low, s) => Math.min(low, s.from), from)
    const regionTo = near.reduce((high, s) => Math.max(high, s.to), to)
    const others = otherSyntax(cx, format, regionFrom, regionTo)
    const spans = spansNear(
      cx,
      format,
      others.reduce((low, o) => Math.min(low, o.from), regionFrom),
      others.reduce((high, o) => Math.max(high, o.to), regionTo),
    )
    // Whether a character is formatted afterwards (null: one of the format's markers).
    const index = new SpanIndex(spans)
    const formatted = (pos: number): boolean | null => {
      if (index.marker(pos)) return null
      if (from <= pos && pos < to) return apply
      return index.inside(pos)
    }
    const breaks = (node: Syntax) => {
      const states = new Set<boolean>()
      const markers = new Set<boolean>()
      for (let pos = node.from; pos < node.to; pos++) {
        const on = formatted(pos)
        if (on === null) continue
        states.add(on)
        if (pos < node.openTo || pos >= node.closeFrom) markers.add(on)
      }
      if (states.size < 2) return false
      return !node.nest || markers.has(true)
    }
    const broken = others.find(breaks)
    if (!broken) return { ...seg, from, to }
    const wider = { from: Math.min(from, broken.from), to: Math.max(to, broken.to) }
    if ((wider.from === from && wider.to === to) || wider.from < lineFrom || wider.to > lineTo)
      return { ...seg, from, to }
    from = wider.from
    to = wider.to
  }
}

/**
 * How many marker characters to take out around a cursor that sits in an
 * empty pair of the format (`**|**` for bold, `***|***` for bold or
 * italic); 0 when it does not. An empty pair parses as plain text.
 */
function emptyPairAt(cx: Cx, format: InlineFormat, pos: number): number {
  const { open, close } = INLINE[format]
  const ch = open.charAt(0)
  if (format === 'highlight' || open !== ch.repeat(open.length) || close !== open) return 0
  const { state } = cx
  let before = 0
  while (before < pos && state.sliceDoc(pos - before - 1, pos - before) === ch) before++
  let after = 0
  while (pos + after < state.doc.length && state.sliceDoc(pos + after, pos + after + 1) === ch)
    after++
  if (before !== after) return 0
  if (before !== open.length && !(ch === '*' && before === 3)) return 0
  // Markers of real syntax next to the cursor are not an empty pair.
  for (const side of [-1, 1] as const)
    if (cx.tree.resolveInner(pos, side).name.endsWith('Mark')) return 0
  return open.length
}

// Block syntax a line (or a quote's or list item's content) may start with
// that a pair of markers could complete: a code fence or a thematic break.
const FENCE = /^(?:`{3,}|~{3,})/
const RULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const CONTAINER_MARK = /^(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/

/**
 * Whether an empty pair inserted at `pos` would turn its line into block
 * syntax: `~~~~` opens a code fence and `****` is a thematic break, also
 * after quote and list markers or next to the line's own marker characters.
 * An empty pair is only useful as inline text, so formats insert none there.
 */
function pairMakesBlock(state: EditorState, pos: number, pair: string): boolean {
  const line = state.doc.lineAt(pos)
  let rest = line.text.slice(0, pos - line.from) + pair + line.text.slice(pos - line.from)
  for (;;) {
    rest = rest.replace(/^[ \t]+/, '')
    if (FENCE.test(rest) || RULE.test(rest)) return true
    const mark = CONTAINER_MARK.exec(rest)
    if (!mark) return false
    rest = rest.slice(mark[0].length)
  }
}

/**
 * Toggles an inline format on every range: on when any part lacks it, off
 * otherwise. A cursor takes an empty pair to type into, except where it is
 * already in a span of the format or where the pair would make block syntax.
 */
export function toggleInline(state: EditorState, format: InlineFormat): TransactionSpec | null {
  const cx = context(state)
  if (!cx) return null
  const apply = !inlineActive(cx, format)
  const found: Region[] = []
  for (const [i, range] of state.selection.ranges.entries()) {
    if (range.empty) {
      const pos = range.head
      const cursor = { range: i, pos }
      const span = spanAtCursor(cx, format, pos)
      const pair = apply ? emptyPairAt(cx, format, pos) : 0
      if (span) {
        if (!apply) found.push({ ...span, spans: [span], segments: [], cursor, strip: true })
      } else if (pair > 0) {
        const empty = { from: pos - pair, to: pos + pair, openTo: pos, closeFrom: pos }
        found.push({ ...empty, spans: [empty], segments: [], cursor, strip: true })
      } else if (
        apply &&
        !cursorSkipped(cx, pos) &&
        !pairMakesBlock(state, pos, markersFor(format, '').join(''))
      )
        found.push({ from: pos, to: pos, spans: [], segments: [], cursor })
      continue
    }
    for (const part of rangeSegments(cx)[i] ?? []) {
      const seg = widen(cx, format, part, apply)
      const spans = spansNear(cx, format, seg.from, seg.to)
      found.push({
        from: spans.reduce((low, s) => Math.min(low, s.from), seg.from),
        to: spans.reduce((high, s) => Math.max(high, s.to), seg.to),
        spans,
        segments: [seg],
      })
    }
  }
  if (found.length === 0) return null

  const regions: Region[] = []
  for (const r of found.sort((a, b) => a.from - b.from)) {
    const prev = regions.at(-1)
    if (!prev || r.from > prev.to) {
      regions.push(r)
      continue
    }
    if (r.from === r.to && r.spans.length === 0) continue
    prev.to = Math.max(prev.to, r.to)
    const known = new Set(prev.spans.map((o) => o.from))
    prev.spans = [...prev.spans, ...r.spans.filter((s) => !known.has(s.from))]
    prev.segments = [...prev.segments, ...r.segments]
  }

  const changes: ChangeSpec[] = []
  const segmentPos = new Map<Segment, [number, number]>()
  const cursors = new Map<number, number>()
  let delta = 0
  for (const region of regions) {
    const start = region.from + delta
    if (region.from === region.to && region.spans.length === 0) {
      const [open, close] = markersFor(format, '')
      changes.push({ from: region.from, insert: open + close })
      if (region.cursor) cursors.set(region.cursor.range, start + open.length)
      delta += open.length + close.length
      continue
    }
    const { text, offsetOf, rangeOf } = rebuild(cx, format, region, apply)
    const old = state.sliceDoc(region.from, region.to)
    let head = 0
    while (head < old.length && head < text.length && old[head] === text[head]) head++
    let tail = 0
    while (
      tail < old.length - head &&
      tail < text.length - head &&
      old[old.length - 1 - tail] === text[text.length - 1 - tail]
    )
      tail++
    if (head < old.length - tail || head < text.length - tail)
      changes.push({
        from: region.from + head,
        to: region.to - tail,
        insert: text.slice(head, text.length - tail),
      })
    for (const seg of region.segments) {
      const [from, to] = rangeOf(seg.selFrom, seg.selTo)
      segmentPos.set(seg, [start + from, start + to])
    }
    if (region.cursor) cursors.set(region.cursor.range, start + offsetOf(region.cursor.pos))
    delta += text.length - old.length
  }

  const changeSet = state.changes(changes)
  const byRange = new Map<number, [number, number][]>()
  for (const [seg, pos] of segmentPos)
    byRange.set(seg.range, [...(byRange.get(seg.range) ?? []), pos])
  const ranges = state.selection.ranges.map((range, i) => {
    const cursor = cursors.get(i)
    if (cursor !== undefined) return EditorSelection.cursor(cursor)
    const own = (byRange.get(i) ?? []).sort((a, b) => a[0] - b[0])
    const first = own[0]
    const last = own.at(-1)
    if (!first || !last) return range.map(changeSet)
    return range.anchor <= range.head
      ? EditorSelection.range(first[0], last[1])
      : EditorSelection.range(last[1], first[0])
  })
  return spec(changeSet, EditorSelection.create(ranges, state.selection.mainIndex))
}

interface LinkNode {
  from: number
  to: number
  labelFrom: number
  labelTo: number
}

function linksNear(cx: Cx, from: number, to: number): LinkNode[] {
  const links: LinkNode[] = []
  cx.tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'Link') return true
      const link = linkOf(node.node)
      if (!link) return true
      links.push({ from: link.from, to: link.to, labelFrom: link.openTo, labelTo: link.closeFrom })
      return false
    },
  })
  return links
}

function selectedLinks(cx: Cx): LinkNode[] {
  const found = new Map<number, LinkNode>()
  for (const [i, range] of cx.state.selection.ranges.entries()) {
    if (range.empty) {
      for (const l of linksNear(cx, range.head, range.head))
        if (l.from < range.head && range.head < l.to) found.set(l.from, l)
      continue
    }
    for (const seg of rangeSegments(cx)[i] ?? [])
      for (const l of linksNear(cx, seg.from, seg.to))
        if (l.from < seg.to && l.to > seg.from) found.set(l.from, l)
  }
  return [...found.values()]
}

function noLinkAt(cx: Cx, from: number, to: number): boolean {
  let blocked = false
  cx.tree.iterate({
    from,
    to,
    enter(node) {
      if (blocked) return false
      if (node.name === 'Image') {
        const image = linkOf(node.node)
        if (image && image.openTo <= from && to <= image.closeFrom) blocked = true
        return !blocked
      }
      if (ATOMIC.has(node.name) && node.from < from && to < node.to) blocked = true
      return !blocked
    },
  })
  return blocked
}

/**
 * Brackets in `from`–`to` that would end a link's text early or leave it
 * open: those without a partner (brackets in code and other literal syntax
 * do not count). Matched pairs (`[draft]`, `[[Note]]`) may stay.
 */
function loneBrackets(cx: Cx, from: number, to: number): number[] {
  const literal = literalChars(cx, from, to, false)
  const open: number[] = []
  const lone: number[] = []
  for (let p = from; p < to; p++) {
    if (literal.has(p)) continue
    const ch = cx.state.sliceDoc(p, p + 1)
    if (ch === '[') open.push(p)
    else if (ch === ']') {
      if (open.pop() === undefined) lone.push(p)
    }
  }
  return [...lone, ...open]
}

/**
 * The text a link would wrap: the selected segments (cursors aside), widened
 * over syntax a link would cut through, without image text and atoms.
 * Ranges widened over the same syntax become one segment.
 */
function linkSegments(cx: Cx): Segment[] {
  const segments: Segment[] = []
  for (const [i, range] of cx.state.selection.ranges.entries()) {
    if (range.empty) continue
    for (const part of rangeSegments(cx)[i] ?? []) {
      const seg = widen(cx, 'link', part, true)
      if (!noLinkAt(cx, seg.from, seg.to)) segments.push(seg)
    }
  }
  const merged: Segment[] = []
  for (const seg of segments.sort((a, b) => a.from - b.from)) {
    const prev = merged.at(-1)
    if (prev && seg.from < prev.to) prev.to = Math.max(prev.to, seg.to)
    else merged.push({ ...seg })
  }
  return merged
}

/**
 * The edit that keeps a `!` right before `pos` from turning a link that
 * starts there into an image: a backslash before it. None where there is no
 * `!` or it is escaped already.
 */
export function escapeBangBefore(state: EditorState, pos: number): ChangeSpec[] {
  const line = state.doc.lineAt(pos)
  if (pos === line.from || state.sliceDoc(pos - 1, pos) !== '!') return []
  let slashes = 0
  while (
    pos - 2 - slashes >= line.from &&
    state.sliceDoc(pos - 2 - slashes, pos - 1 - slashes) === '\\'
  )
    slashes++
  return slashes % 2 === 0 ? [{ from: pos - 1, insert: '\\' }] : []
}

/**
 * A URL as a link's address: as it is, except that `|` is percent-encoded
 * (in a table it would end the cell), and so are `\` (it would escape the
 * next character, a closing parenthesis too), whitespace (it would end the
 * address) and parentheses that do not pair up (one would end the address early).
 */
export function linkAddress(url: string): string {
  const piped = url
    .replace(/\|/g, '%7C')
    .replace(/\\/g, '%5C')
    .replace(/\s/g, (c) => encodeURIComponent(c))
  let depth = 0
  for (const ch of piped) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) break
  }
  return depth === 0 ? piped : piped.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))
}

/**
 * Makes the selected text a link to `url` (a URL pasted over it), the
 * cursor after each link; one undo step. Null, for the usual paste to
 * replace the text, when a range is empty, the selection touches a link, a
 * selected segment is itself an address, or nothing selected can be linked
 * (code, front matter).
 */
export function linkTo(state: EditorState, url: string): TransactionSpec | null {
  if (state.selection.ranges.some((r) => r.empty)) return null
  const cx = context(state)
  if (!cx || selectedLinks(cx).length > 0) return null
  const segments = linkSegments(cx)
  if (segments.length === 0) return null
  if (segments.some((seg) => URL_ONLY.test(state.sliceDoc(seg.from, seg.to)))) return null
  const inserts: ChangeSpec[] = []
  for (const seg of segments) {
    inserts.push(...escapeBangBefore(state, seg.from))
    inserts.push({ from: seg.from, insert: '[' })
    for (const at of loneBrackets(cx, seg.from, seg.to)) inserts.push({ from: at, insert: '\\' })
    inserts.push({ from: seg.to, insert: `](${linkAddress(url)})` })
  }
  const changes = state.changes(inserts)
  const cursors = segments.map((seg) => EditorSelection.cursor(changes.mapPos(seg.to, 1)))
  return {
    ...spec(changes, EditorSelection.create(cursors)),
    userEvent: 'input.paste',
  }
}

export function selectionHasLink(state: EditorState): boolean {
  const cx = context(state)
  return !!cx && selectedLinks(cx).length > 0
}

function linkLabel(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\\?[[\]]/g, (m) => (m.length === 2 ? m : `\\${m}`))
}

/**
 * The link dialog's result: `[text](url)` in place of the main selection
 * (the URL as its text when `text` is empty), the cursor after it; one undo
 * step.
 */
export function insertLink(state: EditorState, text: string, url: string): TransactionSpec {
  const { from, to } = state.selection.main
  const address = linkAddress(url.trim())
  const label = linkLabel(text.trim() === '' ? url.trim() : text)
  const changes = state.changes([
    ...escapeBangBefore(state, from),
    { from, to, insert: `[${label}](${address})` },
  ])
  return spec(changes, EditorSelection.single(changes.mapPos(to, 1)))
}

/**
 * Removes the links the selection touches (keeping their text); otherwise makes each selected line a
 * link (a selected address becomes its address; at a cursor, an empty link is inserted).
 * Like inline formats, it widens over syntax it would cut through and escapes lone brackets.
 */
export function toggleLink(state: EditorState): TransactionSpec | null {
  const cx = context(state)
  if (!cx) return null
  const links = selectedLinks(cx)
  if (links.length > 0) {
    const changes = state.changes(
      links.flatMap((l) => [
        { from: l.from, to: l.labelFrom },
        { from: l.labelTo, to: l.to },
      ]),
    )
    return spec(changes, state.selection.map(changes))
  }
  return newLinks(cx, '')
}

/**
 * New links (`mark` '') or images (`mark` '!'): an empty one at each
 * cursor, with the cursor in its text, and one around each selected segment
 * (a selected address becomes its address, with the cursor in its text).
 */
function newLinks(cx: Cx, mark: '' | '!'): TransactionSpec | null {
  const { state } = cx
  const inserts: ChangeSpec[] = []
  const cursorAt: ((changes: ReturnType<EditorState['changes']>) => number)[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) continue
    const pos = range.head
    if (cursorSkipped(cx, pos) || noLinkAt(cx, pos, pos)) continue
    if (mark === '') inserts.push(...escapeBangBefore(state, pos))
    inserts.push({ from: pos, insert: `${mark}[]()` })
    cursorAt.push((c) => c.mapPos(pos, -1) + mark.length + 1)
  }
  for (const seg of linkSegments(cx)) {
    if (mark === '') inserts.push(...escapeBangBefore(state, seg.from))
    if (URL_ONLY.test(state.sliceDoc(seg.from, seg.to))) {
      inserts.push({ from: seg.from, insert: `${mark}[](` }, { from: seg.to, insert: ')' })
      cursorAt.push((c) => c.mapPos(seg.from, 1) - 2)
    } else {
      inserts.push({ from: seg.from, insert: `${mark}[` })
      for (const at of loneBrackets(cx, seg.from, seg.to)) inserts.push({ from: at, insert: '\\' })
      inserts.push({ from: seg.to, insert: ']()' })
      cursorAt.push((c) => c.mapPos(seg.to, 1) - 1)
    }
  }
  if (inserts.length === 0) return null
  const changes = state.changes(inserts)
  const cursors = cursorAt.map((at) => EditorSelection.cursor(at(changes)))
  return spec(changes, EditorSelection.create(cursors))
}

/**
 * Inserts images as Toggle Link inserts links: an empty `![]()` at a cursor
 * (the cursor in its text), selected text as an image's text, a selected
 * address as its address. Nothing happens when the selection touches a
 * link, nor where a link could not go.
 */
export function insertImage(state: EditorState): TransactionSpec | null {
  const cx = context(state)
  if (!cx || selectedLinks(cx).length > 0) return null
  return newLinks(cx, '!')
}

const NOTE_QUERY = /^[^[\]|\n]*$/

/**
 * Inserts `[[]]` at the main cursor, or around its selected text, with the
 * cursor before the closing brackets: there the `[[` popup searches notes
 * for the text in between (see linkCompletion.ts). Nothing happens where a
 * link could not go, in a link, or for text the popup cannot search for.
 */
export function insertNoteLink(state: EditorState): TransactionSpec | null {
  const cx = context(state)
  if (!cx) return null
  const { from, to } = state.selection.main
  if (!NOTE_QUERY.test(state.sliceDoc(from, to))) return null
  if (cursorSkipped(cx, from) || noLinkAt(cx, from, to)) return null
  if (linksNear(cx, from, to).some((l) => l.from < to && from < l.to)) return null
  const changes = state.changes([
    { from, insert: '[[' },
    { from: to, insert: ']]' },
  ])
  return spec(changes, EditorSelection.single(to + 2))
}

/**
 * Where a line's heading goes: after its quote and list markers (those the
 * syntax tree has). Null for a task item, whose box would become heading text.
 */
function lineHeading(cx: Cx, line: Line): { container: number; level: number; end: number } | null {
  const container = containerEnd(cx, line)
  const rest = line.text.slice(container)
  const m = /^(#{1,6})(?:[ \t]+|$)/.exec(rest)
  if (m) return { container, level: m[1]?.length ?? 0, end: container + m[0].length }
  if (nodeAt(cx, line.from + container).name === 'TaskMarker') return null
  return { container, level: 0, end: container }
}

function setextOf(cx: Cx, line: Line): SyntaxNode | null {
  const at = blockPrefix(cx, line)
  if (at >= line.length) return null
  for (let node: SyntaxNode | null = nodeAt(cx, line.from + at); node;) {
    if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') return node
    node = node.parent
  }
  return null
}

function lineLevel(cx: Cx, line: Line): number {
  const setext = setextOf(cx, line)
  if (setext) return setext.name === 'SetextHeading1' ? 1 : 2
  return lineBlock(cx, line).kind === 'text' ? (lineHeading(cx, line)?.level ?? 0) : 0
}

interface HeadingEdit {
  level: number
  edit: (target: number) => ChangeSpec[]
}

function atxEdit(line: Line, container: number, level: number, end: number): HeadingEdit {
  const at = line.from + container
  const pad = container > 0 && !/[ \t]$/.test(line.text.slice(0, container)) ? ' ' : ''
  return {
    level,
    edit: (target) => {
      if (target === 0) return [{ from: at, to: line.from + end }]
      if (level === 0) return [{ from: at, insert: pad + '#'.repeat(target) + ' ' }]
      if (target > level) return [{ from: at, insert: '#'.repeat(target - level) }]
      return [{ from: at, to: at + level - target }]
    },
  }
}

const SETEXT_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*/

/**
 * A setext heading always loses its underline. Removing the heading leaves
 * a paragraph (a blank line keeps it apart from a paragraph right below);
 * an ATX level goes on its first line, with its other lines joined to it.
 */
function setextEdit(cx: Cx, node: SyntaxNode): HeadingEdit {
  const { doc } = cx.state
  const mark = node.getChild('HeaderMark')
  const underline = doc.lineAt(mark ? mark.from : node.to)
  const first = doc.lineAt(node.from)
  const last = doc.line(Math.max(first.number, underline.number - 1))
  return {
    level: node.name === 'SetextHeading1' ? 1 : 2,
    edit: (target) => {
      if (target === 0) {
        const next = underline.number < doc.lines ? doc.line(underline.number + 1) : null
        if (mark && next && !/^[ \t>]*$/.test(next.text))
          return [{ from: mark.from, to: underline.to }]
        return [{ from: last.to, to: underline.to }]
      }
      const changes: ChangeSpec[] = [{ from: last.to, to: underline.to }]
      for (let n = first.number + 1; n <= last.number; n++) {
        const line = doc.line(n)
        const prefix = SETEXT_PREFIX.exec(line.text)?.[0].length ?? 0
        changes.push({ from: doc.line(n - 1).to, to: line.from + prefix, insert: ' ' })
      }
      const container = lineHeading(cx, first)?.container ?? node.from - first.from
      return [...atxEdit(first, container, 0, container).edit(target), ...changes]
    },
  }
}

/**
 * The headings the selection covers: every line that can be one (blank
 * lines are skipped when there are several), a setext heading once.
 */
function selectedHeadings(cx: Cx): HeadingEdit[] {
  const { state } = cx
  const numbers = new Set<number>()
  for (const range of state.selection.ranges)
    for (const n of rangeLines(state, range)) numbers.add(n)
  const lines = [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n))
  const several = lines.length > 1
  const setexts = new Set<number>()
  const edits: HeadingEdit[] = []
  for (const line of lines) {
    const setext = setextOf(cx, line)
    if (setext) {
      if (!setexts.has(setext.from)) edits.push(setextEdit(cx, setext))
      setexts.add(setext.from)
      continue
    }
    if (lineBlock(cx, line).kind !== 'text' || (several && line.text.trim() === '')) continue
    const heading = lineHeading(cx, line)
    if (heading) edits.push(atxEdit(line, heading.container, heading.level, heading.end))
  }
  return edits
}

/**
 * The change that gives each selected heading the level `targetOf` picks for
 * it (0: none), from its own level and those of all of them.
 */
function headingSpec(
  cx: Cx,
  targetOf: (level: number, all: readonly HeadingEdit[]) => number,
): TransactionSpec | null {
  const { state } = cx
  const headings = selectedHeadings(cx)
  if (headings.length === 0) return null
  const changes = headings.flatMap((h) => {
    const target = targetOf(h.level, headings)
    return h.level === target ? [] : h.edit(target)
  })
  if (changes.length === 0) return null
  const changeSet = state.changes(changes)
  const ranges = state.selection.ranges.map((r) => {
    if (r.empty) return EditorSelection.cursor(changeSet.mapPos(r.head, 1))
    const forward = r.anchor < r.head
    return EditorSelection.range(
      changeSet.mapPos(r.anchor, forward ? -1 : 1),
      changeSet.mapPos(r.head, forward ? 1 : -1),
    )
  })
  return spec(changeSet, EditorSelection.create(ranges, state.selection.mainIndex))
}

export function setHeading(state: EditorState, level: number): TransactionSpec | null {
  const cx = context(state)
  return (
    cx &&
    headingSpec(cx, (_, all) => (level > 0 && all.every((h) => h.level === level) ? 0 : level))
  )
}

/** Steps the heading of the selected lines: none, 1, 2, … 6, then none again. */
export function cycleHeading(state: EditorState): TransactionSpec | null {
  const cx = context(state)
  if (!cx) return null
  const line = state.doc.lineAt(state.selection.main.from)
  const level = (lineLevel(cx, line) + 1) % 7
  return headingSpec(cx, () => level)
}

/**
 * Steps each selected line's heading on its own: smaller goes none, 1, 2, …
 * 6, then none again; bigger goes none, 6, 5, … 1, then none again.
 */
export function stepHeading(state: EditorState, way: 'bigger' | 'smaller'): TransactionSpec | null {
  const cx = context(state)
  if (!cx) return null
  return headingSpec(cx, (level) =>
    way === 'smaller' ? (level + 1) % 7 : level === 0 ? 6 : level - 1,
  )
}

export const FORMAT_COMMANDS: Record<FormatId, FormatCommand> = {
  heading: cycleHeading,
  heading1: (s) => setHeading(s, 1),
  heading2: (s) => setHeading(s, 2),
  heading3: (s) => setHeading(s, 3),
  heading4: (s) => setHeading(s, 4),
  heading5: (s) => setHeading(s, 5),
  heading6: (s) => setHeading(s, 6),
  headingBigger: (s) => stepHeading(s, 'bigger'),
  headingSmaller: (s) => stepHeading(s, 'smaller'),
  bold: (s) => toggleInline(s, 'bold'),
  italic: (s) => toggleInline(s, 'italic'),
  strikethrough: (s) => toggleInline(s, 'strikethrough'),
  highlight: (s) => toggleInline(s, 'highlight'),
  link: toggleLink,
  code: (s) => toggleInline(s, 'code'),
  codeBlock: codeBlockCommand,
  bulletList: (s) => toggleList(s, 'bullet'),
  numberedList: (s) => toggleList(s, 'numbered'),
  taskList: (s) => toggleList(s, 'task'),
  quote: toggleQuote,
  horizontalRule: insertRule,
  ...(Object.fromEntries(
    ALERT_KINDS.map((kind) => [alertFormat(kind), (s: EditorState) => toggleAlert(s, kind)]),
  ) as Record<AlertFormat, FormatCommand>),
}

const NO_INLINE: Record<InlineFormat | 'link', boolean> = {
  bold: false,
  italic: false,
  strikethrough: false,
  highlight: false,
  link: false,
  code: false,
}

export type ToolbarFormat = 'heading' | InlineFormat | 'link' | BlockFormat

/**
 * A format command for CodeMirror: dispatches the format's transaction.
 * False when the format does nothing here, so the key goes to the next
 * binding (Mod-i in code selects the parent syntax), and while an input
 * method composes (a Format menu item, say): a format would end the
 * composition and leave its raw text in the note.
 */
export function formatCommand(id: FormatId): Command {
  return (view) => {
    if (editorComposes(view)) return false
    const tr = FORMAT_COMMANDS[id](view.state)
    if (!tr) return false
    view.dispatch(tr)
    // A new code block lists the fence languages at once (editor/codeBlocks.ts).
    if (id === 'codeBlock' && atNewFence(view.state)) startCompletion(view)
    return true
  }
}

/** Selections longer than this are not tried by `inertFormats`: the work is not worth a guess. */
const INERT_CHECK_MAX = 5000

/**
 * The formats that would do nothing at the selection, such as every inline
 * format inside code. The Format menu offers a format's key only where the
 * format applies, so elsewhere the key reaches the editor's other bindings
 * (Cmd+I selects the parent syntax in code). Nothing is inert while the
 * parser has not reached the selection, and for a long selection: a key
 * left to the menu is the safe side.
 */
export function inertFormats(state: EditorState): FormatId[] {
  if (state.selection.ranges.some((r) => r.to - r.from > INERT_CHECK_MAX)) return []
  if (!context(state, TOOLBAR_PARSE_MS)) return []
  return (Object.keys(FORMAT_COMMANDS) as FormatId[]).filter(
    (id) => FORMAT_COMMANDS[id](state) === null,
  )
}

/**
 * Which toolbar formats the selection has (the pressed buttons). None while
 * the parser has not reached the selection: the toolbar waits for it only
 * briefly, and renders again once the tree is there. A selection of more
 * than `TOOLBAR_MAX_LINES` lines shows none either (the heading apart): the
 * toolbar re-reads the selection on every change, so its cost is bounded,
 * not that of the note. The commands still act on the whole selection.
 */
export function formatState(state: EditorState): Record<ToolbarFormat, boolean> {
  const cx = context(state, TOOLBAR_PARSE_MS)
  if (!cx) return { heading: false, ...NO_INLINE, ...NO_BLOCKS }
  const line = state.doc.lineAt(state.selection.main.from)
  if (!toolbarReads(state)) return { heading: lineLevel(cx, line) > 0, ...NO_INLINE, ...NO_BLOCKS }
  return {
    heading: lineLevel(cx, line) > 0,
    bold: inlineActive(cx, 'bold'),
    italic: inlineActive(cx, 'italic'),
    strikethrough: inlineActive(cx, 'strikethrough'),
    highlight: inlineActive(cx, 'highlight'),
    link: selectedLinks(cx).length > 0,
    code: inlineActive(cx, 'code'),
    ...blockStateOf(cx),
  }
}
