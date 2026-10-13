// The readable text of a note body: what a search result's excerpt shows.
// A leading front matter block is skipped (the same fences the editor and
// the preview read), and Markdown markers come out: heading, list, quote,
// task and alert markers, emphasis, strong and strikethrough, code fences
// and code span backticks, link and image syntax (their text and alt text
// stay), footnote references, link reference definitions, table pipes, HTML
// tags and comments. Text that only looks like syntax stays, as the preview
// shows it: an unpaired `*` or `_`, brackets that make no link, a `<` that
// opens no tag. What is left reads as text, with each run of whitespace one
// space. It never throws and runs in linear time.
//
// This follows CommonMark closely but not fully: emphasis pairs within a
// paragraph by the flanking rules, without the rule of three; indented code
// is read as text; `[[target]]` and `[[target|label]]` (from other tools)
// show their label, else their target. The Rust store's `readable_text`
// (src-tauri/src/storage/readable.rs) follows the same rules step for step;
// tests/support/readable-text.json holds cases both sides must agree on.
// Positions are counted in code points on both sides.

import { isWhitespace } from './text'

/** A front matter fence: three dashes, then only spaces or tabs (as the editor and preview read it). */
export const FRONT_MATTER_FENCE = /^---[ \t]*$/
/** The whitespace an excerpt folds into one space. */
const BLANKS = /[ \t\n\r\f\v]+/g
/** An alert's marker line in a quote, as the preview reads it. */
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i
/** Most characters a reference label holds. */
const MAX_LABEL_CHARS = 999

const isSpace = (c: string | undefined) => c === ' ' || c === '\t'
const isWord = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c)
const isLetter = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c)
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')
const isPunctuation = (c: string | undefined) => c !== undefined && PUNCTUATION.has(c)
/** Unicode whitespace (as Rust's `char::is_whitespace`); the start or end of a line counts. */
const isWhite = (c: string | undefined) => c === undefined || isWhitespace(c)
/** A letter or a digit in any script (as Rust's `char::is_alphanumeric`). */
const isAlnum = (c: string | undefined) => c !== undefined && /[\p{Alphabetic}\p{N}]/u.test(c)
/** For emphasis: anything that is neither whitespace nor a letter or digit. */
const isMark = (c: string | undefined) => !isWhite(c) && !isAlnum(c)

/** A run of `*`, `_` or `~` that may open or close emphasis; what is left unpaired shows. */
interface Delimiter {
  char: string
  open: boolean
  close: boolean
  /** How many of its characters are not paired yet. */
  left: number
}
type Piece = string | Delimiter

/** A line of a paragraph to read inline, a line of code, or the end of a paragraph. */
type Op =
  | { kind: 'text'; line: string[]; table: boolean; start: boolean }
  | { kind: 'code'; text: string }
  | { kind: 'end' }

/** The readable text of `markdown`; see the top of this file. */
export function readableText(markdown: string): string {
  const lines = markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  let first = 0
  if (FRONT_MATTER_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_FENCE.test(l))
    if (close > 0) first = close + 1
  }
  const { ops, labels } = blocks(lines.slice(first))

  // Inline markers next, once every link reference is known.
  const out: string[] = []
  // The paragraph being read: emphasis pairs within it.
  let paragraph: Piece[] = []
  for (const op of ops) {
    if (op.kind === 'end') {
      if (paragraph.length > 0) out.push(render(paragraph))
      paragraph = []
    } else if (op.kind === 'code') out.push(op.text)
    else {
      if (paragraph.length > 0) paragraph.push('\n')
      // One by one: a long line holds more pieces than a call takes arguments.
      for (const piece of inline(op.line, labels, op.table, op.start)) paragraph.push(piece)
    }
  }
  if (paragraph.length > 0) out.push(render(paragraph))
  return out.join('\n').replace(BLANKS, ' ').replace(/^ | $/g, '')
}

/**
 * The block structure of `body`: its lines with block markers taken out
 * (code fences, headings, quotes, lists, breaks, tables, definitions, HTML
 * comment blocks, alert markers), and the labels of its link reference
 * definitions.
 */
function blocks(body: readonly string[]): { ops: Op[]; labels: Set<string> } {
  const ops: Op[] = []
  const labels = new Set<string>()
  // A paragraph is open, and whether it started on a list item.
  let open = false
  let listParagraph = false
  const end = () => {
    if (open) ops.push({ kind: 'end' })
    open = false
  }
  // An open code fence: its character, its length, and the quote markers before it.
  let fence: { char: string; length: number; quotes: number } | null = null
  // Inside an HTML comment block, up to the line that closes it.
  let comment = false
  // Inside a table: from its header row (a delimiter row follows) to a blank line.
  let table = false
  for (const [l, raw] of body.entries()) {
    if (comment) {
      const close = raw.indexOf('-->')
      if (close < 0) continue
      comment = false
      ops.push({ kind: 'text', line: [...raw.slice(close + 3)], table: false, start: false })
      open = true
      end()
      continue
    }
    if (fence) {
      const quoted = stripQuotes([...raw], fence.quotes)
      // Code in a quote ends with the quote.
      if (quoted.quotes === fence.quotes) {
        const line = quoted.line
        const run = runOf(line, 0, fence.char)
        if (run >= fence.length && line.slice(run).every(isSpace)) fence = null
        else ops.push({ kind: 'code', text: line.join('') })
        continue
      }
      fence = null
    }
    const marked = blockMarkers([...raw], open && !listParagraph)
    let line = marked.line
    const head = line[0]
    const run = head === '`' || head === '~' ? runOf(line, 0, head) : 0
    // A backtick fence's info string holds no backtick (else it is code inline).
    if (run >= 3 && (head === '~' || !line.slice(run).includes('`'))) {
      end()
      fence = { char: head!, length: run, quotes: marked.quotes }
      table = false
      continue
    }
    if (line.length === 0) {
      end()
      table = false
      continue
    }
    if (!table && line.includes('|')) {
      const next = body[l + 1]
      table = next !== undefined && isDelimiterRow(blockMarkers([...next], false).line)
    }
    if (
      isBreak(line, open) ||
      isDelimiterRow(line) ||
      (marked.quotes > 0 && ALERT.test(line.join('')))
    ) {
      end()
      continue
    }
    // A definition never continues a paragraph. A footnote definition keeps
    // its text; a link reference definition is all syntax.
    const label = open ? null : definition(line)
    if (typeof label === 'string') {
      labels.add(label)
      continue
    }
    if (label !== null) line = line.slice(label)
    const heading = stripHeading(line)
    // These are blocks of their own.
    const own = heading !== null || table || label !== null
    if (own || marked.list) end()
    if (!open) listParagraph = marked.list
    // A line opening with <!-- that does not close it opens a comment block.
    const start = /^[ \t]*<!--/.test(raw)
    ops.push({ kind: 'text', line: heading ?? line, table, start })
    open = true
    comment = start && !raw.slice(raw.indexOf('<!--') + 4).includes('-->')
    if (own || comment) end()
  }
  end()
  return { ops, labels }
}

/**
 * The text of a paragraph's pieces: delimiters that pair come out, two
 * characters at a time while both runs have two, else one; what is left of
 * a run shows.
 */
function render(pieces: Piece[]): string {
  // Openers waiting for a closer, by character.
  const open: Record<string, number[]> = { '*': [], _: [], '~': [] }
  for (const [k, piece] of pieces.entries()) {
    if (typeof piece === 'string') continue
    const waiting = open[piece.char]!
    if (piece.close) {
      while (piece.left > 0 && waiting.length > 0) {
        const at = waiting.at(-1)!
        const opener = pieces[at] as Delimiter
        const used = opener.left >= 2 && piece.left >= 2 ? 2 : 1
        opener.left -= used
        piece.left -= used
        if (opener.left === 0) waiting.pop()
        // Openers inside the pair can no longer close past it.
        for (const other of Object.values(open)) {
          if (other === waiting) continue
          while (other.length > 0 && other.at(-1)! > at) other.pop()
        }
      }
    }
    if (piece.open && piece.left > 0) waiting.push(k)
  }
  return pieces.map((p) => (typeof p === 'string' ? p : p.char.repeat(p.left))).join('')
}

/**
 * A reference label as definitions and links compare it, case and spacing
 * ignored; null when it is blank or too long to be one.
 */
function normalizeLabel(label: readonly string[]): string | null {
  if (label.length > MAX_LABEL_CHARS) return null
  const key = label.join('').replace(BLANKS, ' ').replace(/^ | $/g, '').toLowerCase()
  return key === '' ? null : key
}

/** How many `char` follow one another from `at`. */
function runOf(chars: readonly string[], at: number, char: string): number {
  let end = at
  while (chars[end] === char) end += 1
  return end - at
}

/** Leading whitespace and up to `quotes` quote markers: a line of code in a quote. */
function stripQuotes(line: string[], quotes: number): { line: string[]; quotes: number } {
  let at = 0
  let found = 0
  for (;;) {
    while (isSpace(line[at])) at += 1
    if (found === quotes || line[at] !== '>') return { line: line.slice(at), quotes: found }
    at += 1
    found += 1
  }
}

/**
 * Leading whitespace, quote markers, list markers and task boxes, nested in
 * any order; also how many quote markers there were and whether a list
 * marker was among them. In a paragraph (`paragraph`), only an ordered list
 * starting at 1 begins a list, so a line such as "2019. Then" stays text.
 */
function blockMarkers(
  line: string[],
  paragraph: boolean,
): { line: string[]; quotes: number; list: boolean } {
  let at = 0
  let quotes = 0
  let list = false
  for (;;) {
    while (isSpace(line[at])) at += 1
    const c = line[at]
    if (c === '>') {
      at += 1
      quotes += 1
      continue
    }
    let marker = 0
    if (c === '-' || c === '*' || c === '+') marker = 1
    else if (isDigit(c)) {
      let digits = 0
      while (isDigit(line[at + digits])) digits += 1
      const after = line[at + digits]
      const one =
        line
          .slice(at, at + digits)
          .join('')
          .replace(/^0+/, '') === '1'
      const interrupts = !paragraph || list || one
      if (digits <= 9 && (after === '.' || after === ')') && interrupts) marker = digits + 1
    }
    const next = line[at + marker]
    if (marker === 0 || (next !== undefined && !isSpace(next)))
      return { line: line.slice(at), quotes, list }
    at += marker
    list = true
    while (isSpace(line[at])) at += 1
    // A task box right after a list marker.
    const box = line[at + 1]
    if (
      line[at] === '[' &&
      (box === ' ' || box === 'x' || box === 'X') &&
      line[at + 2] === ']' &&
      (line[at + 3] === undefined || isSpace(line[at + 3]))
    )
      at += 3
  }
}

/**
 * A thematic break (three or more of `-*_`, spaces allowed) or, under a
 * paragraph (`paragraph`), a setext underline (`=` or `-` repeated).
 */
function isBreak(line: readonly string[], paragraph: boolean): boolean {
  const mark = line[0]
  if (mark !== '=' && mark !== '-' && mark !== '*' && mark !== '_') return false
  if (!line.every((c) => c === mark || isSpace(c))) return false
  if (paragraph && (mark === '=' || mark === '-')) return true
  return mark !== '=' && line.filter((c) => c === mark).length >= 3
}

/** A table's delimiter row, such as `|---|:-:|`. */
function isDelimiterRow(line: readonly string[]): boolean {
  return (
    line.includes('|') &&
    line.includes('-') &&
    line.every((c) => c === '|' || c === ':' || c === '-' || isSpace(c))
  )
}

/**
 * A line that defines a link reference (`[label]: destination "title"`):
 * its normalized label; a footnote (`[^label]: text`): where its text
 * starts; else null.
 */
function definition(line: readonly string[]): string | number | null {
  if (line[0] !== '[') return null
  const close = line.indexOf(']')
  if (close < 2 || line[close + 1] !== ':') return null
  const label = normalizeLabel(line.slice(1, close))
  if (label === null) return null
  let at = close + 2
  while (isSpace(line[at])) at += 1
  if (line[1] === '^') return at
  // The destination: <...>, or text up to a space.
  const start = at
  if (line[at] === '<') {
    while (at < line.length && line[at] !== '>') at += 1
    if (line[at] !== '>') return null
    at += 1
  } else while (at < line.length && !isSpace(line[at])) at += 1
  if (at === start) return null
  while (isSpace(line[at])) at += 1
  return at === line.length || isTitle(line, at, line.length) ? label : null
}

/** Whether `from` to `to` (spaces around allowed) is a link title: "...", '...' or (...). */
function isTitle(c: readonly string[], from: number, to: number): boolean {
  let end = to
  while (end > from && isSpace(c[end - 1])) end -= 1
  const closer = { '"': '"', "'": "'", '(': ')' }[c[from]!]
  return closer !== undefined && end - from >= 2 && c[end - 1] === closer
}

/**
 * From each position of a line (and its end): the next space or tab, the
 * next character that is neither, and the next unescaped `<` or `>`; the
 * line's length when there is none. With these a destination is checked in
 * constant time, however many links share a long run of text.
 */
interface Ahead {
  space: Int32Array
  solid: Int32Array
  angle: Int32Array
}

function aheadOf(c: readonly string[]): Ahead {
  const n = c.length
  // A character after an odd run of backslashes is escaped.
  const escaped = new Uint8Array(n)
  let slashes = 0
  for (let i = 0; i < n; i += 1) {
    escaped[i] = slashes % 2
    slashes = c[i] === '\\' ? slashes + 1 : 0
  }
  const space = new Int32Array(n + 1).fill(n)
  const solid = new Int32Array(n + 1).fill(n)
  const angle = new Int32Array(n + 1).fill(n)
  for (let i = n - 1; i >= 0; i -= 1) {
    const blank = isSpace(c[i])
    space[i] = blank ? i : space[i + 1]!
    solid[i] = blank ? solid[i + 1]! : i
    angle[i] = (c[i] === '<' || c[i] === '>') && escaped[i] === 0 ? i : angle[i + 1]!
  }
  return { space, solid, angle }
}

/** Whether `from` to `to` (inside a link's parentheses) is a destination and an optional title. */
function isDestination(c: readonly string[], ahead: Ahead, from: number, to: number): boolean {
  let at = Math.min(ahead.solid[from]!, to)
  if (at < to && c[at] === '<') {
    // <...> holds no unescaped `<`, as in CommonMark.
    const end = ahead.angle[at + 1]!
    if (end >= to || c[end] !== '>') return false
    at = end + 1
  } else at = Math.min(ahead.space[at]!, to)
  at = Math.min(ahead.solid[at]!, to)
  return at === to || isTitle(c, at, to)
}

/** The text of an ATX heading without its hashes; null when the line is no heading. */
function stripHeading(line: string[]): string[] | null {
  const level = runOf(line, 0, '#')
  if (level === 0 || level > 6 || (line[level] !== undefined && !isSpace(line[level]))) return null
  let start = level
  while (isSpace(line[start])) start += 1
  let end = line.length
  while (end > start && isSpace(line[end - 1])) end -= 1
  let hashes = end
  while (hashes > start && line[hashes - 1] === '#') hashes -= 1
  if (hashes === start || isSpace(line[hashes - 1])) end = hashes
  return line.slice(start, end)
}

/**
 * Inline markers out of one line, as pieces of text and emphasis
 * delimiters. `labels` are the defined link references; `table` turns
 * pipes into spaces. `start`: the line opens a comment block, so its text
 * ends at the unclosed `<!--`; elsewhere an unclosed `<!--` is text.
 */
function inline(
  c: readonly string[],
  labels: ReadonlySet<string>,
  table: boolean,
  start: boolean,
): Piece[] {
  const n = c.length
  const escaped = (i: number) => c[i] === '\\' && isPunctuation(c[i + 1])

  // Code spans: a backtick run closes at the next run of the same length.
  // Backslashes are text inside code, but one before a run keeps it from opening.
  const runs: { at: number; length: number }[] = []
  for (let i = 0; i < n;) {
    if (c[i] === '`') {
      const length = runOf(c, i, '`')
      runs.push({ at: i, length })
      i += length
    } else i += 1
  }
  const nextSame: (number | undefined)[] = Array.from({ length: runs.length })
  const lastOf = new Map<number, number>()
  for (let r = runs.length - 1; r >= 0; r -= 1) {
    const run = runs[r]!
    nextSame[r] = lastOf.get(run.length)
    lastOf.set(run.length, r)
  }
  // Code span start -> its closing run's start.
  const spans = new Map<number, number>()
  for (let r = 0; r < runs.length;) {
    const close = nextSame[r]
    const run = runs[r]!
    if (close === undefined || c[run.at - 1] === '\\') {
      r += 1
      continue
    }
    spans.set(run.at, runs[close]!.at)
    r = close + 1
  }

  // Matching brackets and parentheses, outside code spans and escapes.
  const bracket = new Map<number, number>()
  const paren = new Map<number, number>()
  const brackets: number[] = []
  const parens: number[] = []
  for (let i = 0; i < n;) {
    const span = spans.get(i)
    if (span !== undefined) {
      i = span + runOf(c, i, '`')
      continue
    }
    if (escaped(i)) {
      i += 2
      continue
    }
    const ch = c[i]
    if (ch === '[') brackets.push(i)
    else if (ch === ']' && brackets.length > 0) bracket.set(brackets.pop()!, i)
    else if (ch === '(') parens.push(i)
    else if (ch === ')' && parens.length > 0) paren.set(parens.pop()!, i)
    i += 1
  }
  /** Whether the text from `from` to `to` names a link reference definition. */
  const defined = (from: number, to: number) => {
    if (labels.size === 0 || to - from > MAX_LABEL_CHARS) return false
    const key = normalizeLabel(c.slice(from, to))
    return key !== null && labels.has(key)
  }
  /**
   * The end of a link's destination or reference, when `[` at `open` starts
   * one: `(destination "title")`, `[label]` naming a definition, `[]` after
   * a text that names one, or the text alone naming one.
   */
  let tables: Ahead | undefined
  const linkEnd = (open: number): number | undefined => {
    const close = bracket.get(open)
    if (close === undefined) return undefined
    if (c[close + 1] === '(') {
      const end = paren.get(close + 1)
      if (end !== undefined && isDestination(c, (tables ??= aheadOf(c)), close + 2, end)) return end
    } else if (c[close + 1] === '[') {
      const end = bracket.get(close + 1)
      if (end === close + 2 && defined(open + 1, close)) return end
      if (end !== undefined && end > close + 2) {
        if (defined(close + 2, end)) return end
        return undefined
      }
    }
    return defined(open + 1, close) ? close : undefined
  }

  // Where each HTML comment's `-->` is, for the next one from a position.
  const commentEnds: number[] = []
  if (c.includes('<')) {
    for (let k = 0; k + 2 < n; k += 1)
      if (c[k] === '-' && c[k + 1] === '-' && c[k + 2] === '>') commentEnds.push(k)
  }
  let nextEnd = 0
  const commentEnd = (from: number) => {
    while (nextEnd < commentEnds.length && commentEnds[nextEnd]! < from) nextEnd += 1
    return commentEnds[nextEnd]
  }

  const pieces: Piece[] = []
  let text = ''
  // Where to go on from a link text's closing bracket: past its destination;
  // and those closing brackets still ahead, innermost last.
  const resume = new Map<number, number>()
  const ahead: number[] = []
  const goOn = (from: number, to: number) => {
    resume.set(from, to)
    ahead.push(from)
  }
  for (let i = 0; i < n;) {
    const jump = resume.get(i)
    if (jump !== undefined) {
      ahead.pop()
      i = jump
      continue
    }
    const ch = c[i]!
    const span = spans.get(i)
    if (span !== undefined) {
      const length = runOf(c, i, '`')
      let from = i + length
      let to = span
      // One space on each side is padding, unless the code is only spaces.
      if (
        c[from] === ' ' &&
        c[to - 1] === ' ' &&
        to - from > 1 &&
        c.slice(from, to).some((x) => x !== ' ')
      ) {
        from += 1
        to -= 1
      }
      text += c.slice(from, to).join('')
      i = span + length
      continue
    }
    if (ch === '\\') {
      if (escaped(i)) {
        text += c[i + 1]
        i += 2
      } else {
        // A backslash ending the line is a hard line break.
        if (i + 1 < n) text += ch
        i += 1
      }
      continue
    }
    if (ch === '<') {
      const skip = htmlEnd(c, i, commentEnd)
      if (skip === 'comment' && start && i === 0) break
      // A tag never runs past the end of the link it starts in.
      if (
        skip !== undefined &&
        skip !== 'comment' &&
        (ahead.length === 0 || skip.end < ahead.at(-1)!)
      ) {
        if (skip.keep) text += c.slice(i + 1, skip.end).join('')
        i = skip.end + 1
        continue
      }
      text += ch
      i += 1
      continue
    }
    if (ch === '!' && c[i + 1] === '[') {
      const end = linkEnd(i + 1)
      if (end !== undefined) {
        goOn(bracket.get(i + 1)!, end + 1)
        i += 2
        continue
      }
    }
    if (ch === '[') {
      const close = bracket.get(i)
      const inner = bracket.get(i + 1)
      // Not right after a letter or digit: x[[1]] is an index.
      const from =
        c[i + 1] === '[' && inner !== undefined && close === inner + 1 && !isAlnum(c[i - 1])
          ? wikiText(c, i + 2, inner)
          : undefined
      if (from !== undefined) {
        goOn(inner!, close! + 1)
        i = from
        continue
      }
      if (c[i + 1] === '^' && close !== undefined && footnote(c, i + 2, close)) {
        i = close + 1
        continue
      }
      const end = linkEnd(i)
      if (end !== undefined) {
        goOn(close!, end + 1)
        i += 1
        continue
      }
      text += ch
      i += 1
      continue
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const length = runOf(c, i, ch)
      // A single tilde is text (about 5); two or more strike through.
      if (ch === '~' && length < 2) {
        text += ch
        i += 1
        continue
      }
      const before = c[i - 1]
      const after = c[i + length]
      const left = !isWhite(after) && (!isMark(after) || isWhite(before) || isMark(before))
      const right = !isWhite(before) && (!isMark(before) || isWhite(after) || isMark(after))
      const underscore = ch === '_'
      pieces.push(text, {
        char: ch,
        open: left && (!underscore || !right || isMark(before)),
        close: right && (!underscore || !left || isMark(after)),
        left: length,
      })
      text = ''
      i += length
      continue
    }
    text += table && ch === '|' ? ' ' : ch
    i += 1
  }
  pieces.push(text)
  return pieces
}

/**
 * Where the shown text of `[[target]]` or `[[target|label]]` starts, given
 * the text between the double brackets (`from` to `to`): the label, else the
 * target. Undefined when that text holds a bracket: then it is no such link.
 */
function wikiText(c: readonly string[], from: number, to: number): number | undefined {
  let label: number | undefined
  for (let k = from; k < to; k += 1) {
    if (c[k] === '[' || c[k] === ']') return undefined
    if (c[k] === '|' && label === undefined) label = k + 1
  }
  return label ?? from
}

/** Whether `from` to `to` is a footnote label: no whitespace and no brackets. */
function footnote(c: readonly string[], from: number, to: number): boolean {
  for (let k = from; k < to; k += 1) if (isSpace(c[k]) || c[k] === '[' || c[k] === ']') return false
  return from < to
}

/**
 * What a `<` at `at` opens: an HTML comment that does not close on this
 * line, a comment or tag to drop (up to `end`, its `>`), an autolink whose
 * address to keep, or nothing (undefined). `commentEnd` finds the next
 * `-->` from a position.
 */
function htmlEnd(
  c: readonly string[],
  at: number,
  commentEnd: (from: number) => number | undefined,
): 'comment' | { end: number; keep: boolean } | undefined {
  if (c[at + 1] === '!' && c[at + 2] === '-' && c[at + 3] === '-') {
    const close = commentEnd(at + 4)
    return close === undefined ? 'comment' : { end: close + 2, keep: false }
  }
  // An autolink: <scheme:address>.
  let k = at + 1
  if (isLetter(c[k])) {
    k += 1
    while (k - at <= 32 && (isWord(c[k]) || c[k] === '+' || c[k] === '.' || c[k] === '-')) k += 1
    if (c[k] === ':') {
      k += 1
      while (k < c.length && !isSpace(c[k]) && c[k] !== '<' && c[k] !== '>') k += 1
      if (c[k] === '>') return { end: k, keep: true }
    }
  }
  // A tag: <name>, <name attributes...>, <name/> or </name>.
  k = at + 1
  const closing = c[k] === '/'
  if (closing) k += 1
  if (!isLetter(c[k])) return undefined
  while (isWord(c[k]) || c[k] === '-') k += 1
  if (isSpace(c[k]) && !closing) {
    while (k < c.length && c[k] !== '>' && c[k] !== '<') k += 1
  } else {
    while (isSpace(c[k])) k += 1
    if (c[k] === '/' && !closing) k += 1
  }
  return c[k] === '>' ? { end: k, keep: false } : undefined
}
