// Appending text at a place in a note (issue #477). The section under a heading runs to the next
// heading of the same or a higher level; a heading inside a fenced code block is none; the heading
// is matched by its text, in any case, the first one found. The note service applies the insertion
// as one Yjs transaction, the AI service as an agent's write of the whole body.

import { TEMPLATES_BOOK_ID } from './books'
import { lineFeeds } from './text'

export type AppendPosition = 'append' | 'prepend'
export type AppendSeparator = 'newline' | 'none'
export const APPEND_POSITIONS: readonly AppendPosition[] = ['append', 'prepend']
export const APPEND_SEPARATORS: readonly AppendSeparator[] = ['newline', 'none']

export interface AppendOptions {
  heading?: string
  position: AppendPosition
  /** `newline` (the default) puts the text on a line of its own; `none` joins it to the line it lands on. */
  separator?: AppendSeparator
}

export interface Insertion {
  at: number
  text: string
}

/** A heading sent in a call: the text of one line, with or without its `#` marks. */
export const MAX_HEADING_CHARS = 500

interface Line {
  start: number
  end: number
  text: string
}

interface Heading {
  level: number
  key: string
}

function* linesOf(body: string): Generator<Line> {
  let start = 0
  while (start <= body.length) {
    const found = body.indexOf('\n', start)
    const end = found < 0 ? body.length : found
    yield { start, end, text: body.slice(start, end) }
    if (found < 0) return
    start = end + 1
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/

const headingKey = (text: string) =>
  text
    .replace(/[ \t]+#+[ \t]*$/, '')
    .trim()
    .normalize('NFC')
    .toLowerCase()

function headingOf(line: string): Heading | undefined {
  const found = ATX.exec(line)
  if (!found) return undefined
  const key = headingKey(found[2] ?? '')
  return { level: found[1]!.length, key }
}

/** The heading as a call names it: with or without its marks, in any case. */
export function headingKeyOf(heading: string): string {
  return headingKey(heading.trim().replace(/^#{1,6}[ \t]*/, ''))
}

const isBlank = (line: Line) => line.text.trim() === ''

/** The lines of `body` with headings read, fenced code left as plain lines (CommonMark fences: a backtick fence's info string holds no backtick, a closing fence nothing but spaces). */
function readLines(body: string): { line: Line; heading: Heading | undefined }[] {
  const out: { line: Line; heading: Heading | undefined }[] = []
  let fence: string | undefined
  for (const line of linesOf(body)) {
    const found = FENCE.exec(line.text)
    const marks = found?.[1]
    const rest = found ? line.text.slice(found[0].length) : ''
    if (fence) {
      const closes =
        marks !== undefined &&
        marks[0] === fence[0] &&
        marks.length >= fence.length &&
        rest.trim() === ''
      if (closes) fence = undefined
      out.push({ line, heading: undefined })
      continue
    }
    if (marks !== undefined && (marks[0] === '~' || !rest.includes('`'))) fence = marks
    out.push({ line, heading: fence ? undefined : headingOf(line.text) })
  }
  return out
}

/** The text as it goes in: line feeds only, trailing line breaks dropped (a shell's echo adds one). Throws E_APPEND_TEXT_EMPTY. */
function cleanAppendText(text: string): string {
  const clean = lineFeeds(text).replace(/\n+$/, '')
  if (clean.trim() === '') throw new Error('E_APPEND_TEXT_EMPTY')
  return clean
}

/**
 * Where `text` goes in `body` and what goes in there, separator included. Under a heading the text
 * lands after the section's last line with content (append) or before its first (prepend); a
 * section with none takes it right after the heading line. Without a heading the whole note is the
 * section. Throws E_HEADING_NOT_FOUND when no heading matches, E_APPEND_TEXT_EMPTY for blank text.
 */
export function appendInsertion(body: string, text: string, options: AppendOptions): Insertion {
  const clean = cleanAppendText(text)
  const separator = options.separator === 'none' ? '' : '\n'
  const lines = readLines(body)
  let section = lines
  let headingLine: Line | undefined
  if (options.heading !== undefined) {
    const wanted = headingKeyOf(options.heading)
    const at = lines.findIndex(({ heading }) => heading !== undefined && heading.key === wanted)
    if (wanted === '' || at < 0) throw new Error('E_HEADING_NOT_FOUND')
    const level = lines[at]!.heading!.level
    let end = at + 1
    while (end < lines.length) {
      const next = lines[end]!.heading
      if (next !== undefined && next.level <= level) break
      end += 1
    }
    headingLine = lines[at]!.line
    section = lines.slice(at + 1, end)
  }
  const content = section.filter(({ line }) => !isBlank(line))
  if (content.length === 0) {
    // After the heading the text starts a line of its own, whatever the separator.
    return headingLine ? { at: headingLine.end, text: `\n${clean}` } : { at: 0, text: clean }
  }
  if (options.position === 'prepend') {
    return { at: content[0]!.line.start, text: `${clean}${separator}` }
  }
  return { at: content[content.length - 1]!.line.end, text: `${separator}${clean}` }
}

/** The body with the text in place (see appendInsertion). */
export function appendedBody(body: string, text: string, options: AppendOptions): string {
  const insertion = appendInsertion(body, text, options)
  return body.slice(0, insertion.at) + insertion.text + body.slice(insertion.at)
}

export interface TitledNote {
  readonly id: string
  readonly title: string
  readonly bookId: string | null
  readonly updatedAt: number
}

/**
 * The live note a command names by title: an exact match (after NFC normalisation) wins over one
 * differing only in case; templates never count. Throws E_NOTE_NOT_FOUND when none matches and
 * E_NOTE_TITLE_AMBIGUOUS when more than one does at the same level.
 */
export function findNoteByTitle(notes: readonly TitledNote[], title: string): string {
  const wanted = title.trim().normalize('NFC')
  if (wanted === '') throw new Error('E_NOTE_NOT_FOUND')
  const live = notes.filter((note) => note.bookId !== TEMPLATES_BOOK_ID)
  const exact = live.filter((note) => note.title.normalize('NFC') === wanted)
  const found =
    exact.length > 0
      ? exact
      : live.filter((note) => note.title.normalize('NFC').toLowerCase() === wanted.toLowerCase())
  if (found.length === 0) throw new Error('E_NOTE_NOT_FOUND')
  if (found.length > 1) throw new Error('E_NOTE_TITLE_AMBIGUOUS')
  return found[0]!.id
}
