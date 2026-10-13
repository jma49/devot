// New Note from Selection: selected text moves into a note of its own,
// titled after its first line (see NoteService.extract); the editor leaves a
// note link where the text was.

import { clipTitle } from './noteLimits'

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
    const rest = line.replace(CONTAINER_MARKERS, '')
    if (SYNTAX_ONLY.test(rest)) continue
    const heading = HEADING.exec(rest)
    const title = (heading ? (heading[1] ?? '') : rest).trim()
    if (title !== '') return clipTitle(title)
  }
  return ''
}
