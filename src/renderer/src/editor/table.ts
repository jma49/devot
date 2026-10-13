// The table model: a GFM table read from its lines, edited as data, and
// printed back with its columns padded to their widest cell. Pure functions
// over strings; the editor commands (tableCommands.ts) find the table around
// the cursor and turn the result into one transaction.
//
// Rows are split as GFM splits them, before any inline syntax: a pipe ends a
// cell unless a backslash escapes it, also inside a code span (the preview
// reads `x|y` in a cell as two cells too). Cell text is kept as written,
// escapes included, so printing never changes what a cell says.

/** A column's alignment, from its delimiter cell (`---`, `:--`, `--:`, `:-:`). */
export type Align = 'none' | 'left' | 'center' | 'right'

/** A table as data. Every row has as many cells as the header. */
export interface Table {
  readonly header: readonly string[]
  readonly align: readonly Align[]
  readonly rows: readonly (readonly string[])[]
}

/** A cell of a row as written: its trimmed text and where it lies in the line. */
export interface RowCell {
  text: string
  /** The cell's span between its pipes (or the line's ends). */
  from: number
  to: number
  /** Where its trimmed text starts. */
  textFrom: number
}

const BLANK = /^[ \t]*$/
// GFM trims a cell of spaces and tabs only: U+3000, U+00A0 and the like are its text.
const TRIM_START = /^[ \t]+/
const TRIM_END = /[ \t]+$/
const trimCell = (text: string) => text.replace(TRIM_START, '').replace(TRIM_END, '')
const BACKSLASH = 92
const PIPE = 124

/** The cells of a table row; the outer pipes are optional. */
export function splitRow(line: string): RowCell[] {
  const cells: RowCell[] = []
  const lead = line.length - line.replace(TRIM_START, '').length
  let start = line.charCodeAt(lead) === PIPE ? lead + 1 : 0
  let sawPipe = start > 0
  const push = (from: number, to: number) => {
    const raw = line.slice(from, to)
    const textFrom = from + (raw.length - raw.replace(TRIM_START, '').length)
    cells.push({ text: trimCell(raw), from, to, textFrom })
  }
  let escaped = false
  for (let i = start; i < line.length; i++) {
    const code = line.charCodeAt(i)
    if (code === PIPE && !escaped) {
      push(start, i)
      start = i + 1
      sawPipe = true
    }
    escaped = !escaped && code === BACKSLASH
  }
  // What follows the last pipe is a cell unless it is blank (a closing pipe).
  if (!(sawPipe && BLANK.test(line.slice(start)))) push(start, line.length)
  return cells
}

/**
 * The cell a cursor at `ch` in a row is in, and its place in the cell's
 * text; `past` when the cursor is after the row's closing pipe (it counts as
 * in the last cell then).
 */
export function cellAt(
  line: string,
  ch: number,
): { column: number; offset: number; past: boolean } {
  const cells = splitRow(line)
  if (cells.length === 0) return { column: 0, offset: 0, past: false }
  let column = cells.findIndex((cell) => ch <= cell.to)
  const past = column < 0
  if (past) column = cells.length - 1
  const cell = cells[column]!
  return { column, offset: Math.max(0, Math.min(cell.text.length, ch - cell.textFrom)), past }
}

/**
 * Whether a pipe at `ch` in a row would be escaped: it follows an odd run of
 * backslashes, the rule `splitRow` applies.
 */
export function escapedAt(line: string, ch: number): boolean {
  let slashes = 0
  while (ch - slashes > 0 && line.charCodeAt(ch - slashes - 1) === BACKSLASH) slashes++
  return slashes % 2 === 1
}

const DELIMITER_CELL = /^(:?)-+(:?)$/

/** The alignment a delimiter cell sets, or null when it is not one. */
export function parseAlign(cell: string): Align | null {
  const m = DELIMITER_CELL.exec(trimCell(cell))
  if (!m) return null
  if (m[1] && m[2]) return 'center'
  if (m[1]) return 'left'
  return m[2] ? 'right' : 'none'
}

/**
 * The table its lines (without quote or list markers) make: a header, a
 * delimiter row, then the rows. Null when the second line is not a delimiter
 * row. Ragged rows are padded with empty cells to the widest row, so no
 * cell is lost; the header and the alignments too.
 */
export function parseTable(lines: readonly string[]): Table | null {
  const [head, delimiter, ...body] = lines
  if (head === undefined || delimiter === undefined) return null
  const align: Align[] = []
  for (const cell of splitRow(delimiter)) {
    const a = parseAlign(cell.text)
    if (a === null) return null
    align.push(a)
  }
  if (align.length === 0) return null
  const header = splitRow(head).map((c) => c.text)
  const rows = body.map((line) => splitRow(line).map((c) => c.text))
  const width = Math.max(header.length, align.length, ...rows.map((r) => r.length))
  const pad = <T>(cells: T[], fill: T): T[] => [
    ...cells,
    ...Array<T>(width - cells.length).fill(fill),
  ]
  return { header: pad(header, ''), align: pad(align, 'none'), rows: rows.map((r) => pad(r, '')) }
}

// East Asian wide and fullwidth characters: Hangul Jamo, CJK punctuation and
// ideographs, kana, Hangul syllables, compatibility ideographs, CJK forms,
// fullwidth forms, and the supplementary ideograph planes.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]
const EMOJI = /\p{Emoji_Presentation}/u
const EMOJI_VARIATION = String.fromCodePoint(0xfe0f)
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function isWide(code: number): boolean {
  return WIDE.some(([from, to]) => code >= from && code <= to)
}

/**
 * How many columns `text` takes in a monospaced font: wide East Asian
 * characters and emoji take two, combining marks and zero-width characters
 * none, everything else one. Counted per grapheme, so an emoji sequence or
 * a letter with an accent is one character.
 */
export function displayWidth(text: string): number {
  // Plain ASCII, the common case, needs no segmenting.
  if (!/[^\x20-\x7e]/.test(text)) return text.length
  let width = 0
  for (const { segment } of graphemes.segment(text)) {
    if (ZERO_WIDTH.test(segment)) continue
    if (EMOJI.test(segment) || segment.includes(EMOJI_VARIATION)) width += 2
    else width += isWide(segment.codePointAt(0)!) ? 2 : 1
  }
  return width
}

/** A table printed: its lines, and where each cell's text lies in its line. */
export interface Printed {
  lines: string[]
  /** Per line (header, delimiter, rows), per column: the cell's text, or its dashes. */
  cells: { from: number; to: number }[][]
}

/** Narrowest a column gets: room for `:-:`. */
const MIN_WIDTH = 3

function delimiterCell(align: Align, width: number): string {
  switch (align) {
    case 'left':
      return `:${'-'.repeat(width - 1)}`
    case 'right':
      return `${'-'.repeat(width - 1)}:`
    case 'center':
      return `:${'-'.repeat(width - 2)}:`
    default:
      return '-'.repeat(width)
  }
}

/** Spaces before and after a cell's text that fill its column as it is aligned. */
function padding(align: Align, room: number): [number, number] {
  if (align === 'right') return [room, 0]
  if (align === 'center') return [Math.floor(room / 2), Math.ceil(room / 2)]
  return [0, room]
}

/**
 * The table's lines, with outer pipes and every column padded to its widest
 * cell (by display width, three at least); cells are placed by their
 * column's alignment, and the delimiter row keeps the alignment markers.
 */
export function printTable(table: Table): Printed {
  const widths = table.align.map((_, c) =>
    Math.max(
      MIN_WIDTH,
      displayWidth(table.header[c] ?? ''),
      ...table.rows.map((row) => displayWidth(row[c] ?? '')),
    ),
  )
  const lines: string[] = []
  const cells: { from: number; to: number }[][] = []
  const print = (texts: readonly string[], aligned: boolean) => {
    let line = '|'
    const spans: { from: number; to: number }[] = []
    texts.forEach((text, c) => {
      const width = widths[c]!
      const [before, after] = aligned
        ? padding(table.align[c]!, width - displayWidth(text))
        : [0, width - displayWidth(text)]
      line += ` ${' '.repeat(before)}`
      spans.push({ from: line.length, to: line.length + text.length })
      line += `${text}${' '.repeat(after)} |`
    })
    lines.push(line)
    cells.push(spans)
  }
  print(table.header, true)
  print(
    table.align.map((a, c) => delimiterCell(a, widths[c]!)),
    false,
  )
  for (const row of table.rows) print(row, true)
  return { lines, cells }
}

// Edits. Each returns a new table; row indexes count the rows under the
// delimiter row, from 0.

const insertAt = <T>(items: readonly T[], at: number, item: T): T[] => [
  ...items.slice(0, at),
  item,
  ...items.slice(at),
]
const removeAt = <T>(items: readonly T[], at: number): T[] => [
  ...items.slice(0, at),
  ...items.slice(at + 1),
]
const moveTo = <T>(items: readonly T[], from: number, to: number): T[] =>
  insertAt(removeAt(items, from), to, items[from]!)

/** Inserts an empty row at `at` (0 makes it the first row). */
export function insertRow(table: Table, at: number): Table {
  const row = table.header.map(() => '')
  return { ...table, rows: insertAt(table.rows, at, row) }
}

export function deleteRow(table: Table, at: number): Table {
  return { ...table, rows: removeAt(table.rows, at) }
}

export function moveRow(table: Table, from: number, to: number): Table {
  return from === to ? table : { ...table, rows: moveTo(table.rows, from, to) }
}

/** Inserts an empty, unaligned column at `at`. */
export function insertColumn(table: Table, at: number): Table {
  return {
    header: insertAt(table.header, at, ''),
    align: insertAt(table.align, at, 'none'),
    rows: table.rows.map((row) => insertAt(row, at, '')),
  }
}

export function deleteColumn(table: Table, at: number): Table {
  return {
    header: removeAt(table.header, at),
    align: removeAt(table.align, at),
    rows: table.rows.map((row) => removeAt(row, at)),
  }
}

export function moveColumn(table: Table, from: number, to: number): Table {
  if (from === to) return table
  return {
    header: moveTo(table.header, from, to),
    align: moveTo(table.align, from, to),
    rows: table.rows.map((row) => moveTo(row, from, to)),
  }
}

export function setAlign(table: Table, column: number, align: Align): Table {
  return { ...table, align: table.align.map((a, c) => (c === column ? align : a)) }
}
