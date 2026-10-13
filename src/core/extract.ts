// New Note from Selection: selected text moves into a note of its own,
// titled after its first line (see NoteService.extract); the editor leaves a
// note link where the text was.

import { clipTitle } from './noteLimits'
import { FRONT_MATTER_FENCE, readableText } from './readable'

/** Quote, list and task markers before a line's text. */
const CONTAINER_MARKERS =
  /^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]*(?:\[[ xX]\](?=[ \t]|$))?))*[ \t]*/
/** Lines that are only syntax: a code fence, a thematic break, a setext underline. */
const SYNTAX_ONLY = /^(?:(?:`{3,}|~{3,}).*|([-*_])(?:[ \t]*\1){2,}[ \t]*|=+[ \t]*)$/
/** An ATX heading: its marks, its text, and closing marks after a space. */
const HEADING = /^#{1,6}(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/

/**
 * The title for a note made from `text`: its first line with text (code
 * fences, rules and setext underlines skipped), without quote, list, task
 * or heading markers, trimmed, cut to the longest title a
 * note may have. Inline Markdown stays as typed. Empty when no line has text.
 */
export function extractTitle(text: string): string {
  for (const line of text.split(/\r\n?|\n/)) {
    const title = lineTitle(line)
    if (title !== '') return clipTitle(title)
  }
  return ''
}

/** A line's text without quote, list, task or heading markers; empty for a line of syntax only. */
function lineTitle(line: string): string {
  const rest = line.replace(CONTAINER_MARKERS, '')
  if (SYNTAX_ONLY.test(rest)) return ''
  const heading = HEADING.exec(rest)
  return (heading ? (heading[1] ?? '') : rest).trim()
}

/** Characters of a body a headline looks through: a long body is not read whole. */
const HEADLINE_SCAN_CHARS = 4000
/** The longest headline, in code points (the row cuts what does not fit). */
export const HEADLINE_CHARS = 120

/**
 * What the lists call a note that has no title: its first line with
 * readable text, as the preview shows it (front matter skipped, markers and
 * link syntax out), cut to HEADLINE_CHARS. It is shown, never stored as the
 * title. Only the start of the body is read. Empty when it holds no text.
 */
export function headline(markdown: string): string {
  const lines = markdown.slice(0, HEADLINE_SCAN_CHARS).split(/\r\n?|\n/)
  let first = 0
  if (FRONT_MATTER_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_FENCE.test(l))
    if (close > 0) first = close + 1
  }
  for (const line of lines.slice(first)) {
    const text = readableText(lineTitle(line))
    if (text !== '') return [...text].slice(0, HEADLINE_CHARS).join('')
  }
  return ''
}
