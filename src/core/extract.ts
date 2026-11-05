// New Note from Selection: selected text moves into a note of its own, titled after its first line (see NoteService.extract).

import { clipTitle } from './noteLimits'
import { FRONT_MATTER_FENCE, readableText } from './readable'

const CONTAINER_MARKERS =
  /^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]*(?:\[[ xX]\](?=[ \t]|$))?))*[ \t]*/
const SYNTAX_ONLY = /^(?:(?:`{3,}|~{3,}).*|([-*_])(?:[ \t]*\1){2,}[ \t]*|=+[ \t]*)$/
const HEADING = /^#{1,6}(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/

/** Code fences, rules and setext underlines are skipped; inline Markdown stays as typed. Empty when no line has text. */
export function extractTitle(text: string): string {
  for (const line of text.split(/\r\n?|\n/)) {
    const title = lineTitle(line)
    if (title !== '') return clipTitle(title)
  }
  return ''
}

/** Empty for a line of syntax only. */
function lineTitle(line: string): string {
  const rest = line.replace(CONTAINER_MARKERS, '')
  if (SYNTAX_ONLY.test(rest)) return ''
  const heading = HEADING.exec(rest)
  return (heading ? (heading[1] ?? '') : rest).trim()
}

/** The text a line shows as a title, the way `headline` reads it. Empty for a line of syntax only. */
export function lineHeadline(line: string): string {
  return readableText(lineTitle(line))
}

/** Whether a line shown as `headline` says no more than `title`; with no title, the headline is the title. */
export function repeatsTitle(line: string, title: string): boolean {
  const named = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')
  return line !== '' && (title === '' || named(line) === named(title))
}

const HEADLINE_SCAN_CHARS = 4000
export const HEADLINE_CHARS = 120

/** Shown, never stored as the title. Only the start of the body is read. Empty when it holds no text. */
export function headline(markdown: string): string {
  const lines = markdown.slice(0, HEADLINE_SCAN_CHARS).split(/\r\n?|\n/)
  let first = 0
  if (FRONT_MATTER_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_FENCE.test(l))
    if (close > 0) first = close + 1
  }
  for (const line of lines.slice(first)) {
    const text = lineHeadline(line)
    if (text !== '') return [...text].slice(0, HEADLINE_CHARS).join('')
  }
  return ''
}

const EXCERPT_SCAN_CHARS = 2000
export const LIST_EXCERPT_CHARS = 200

/**
 * The first line leads the excerpt only when it says more than the title: for a
 * note with no title it is the headline, for a titled one it usually repeats the
 * title. Empty when nothing is left.
 */
export function listExcerpt(markdown: string, title: string): string {
  let text = readableText(markdown.slice(0, EXCERPT_SCAN_CHARS))
  const first = headline(markdown)
  if (repeatsTitle(first, title) && text.startsWith(first)) text = text.slice(first.length).trim()
  return [...text].slice(0, LIST_EXCERPT_CHARS).join('')
}

// The lines that count, found by one search over the whole text rather than a test of every line:
// a code fence (group 1) or a task item (group 2). Multiline `^` also follows U+2028 and U+2029,
// which do not end a line here, so a match after one is passed over.
const TASK_LINES =
  /^(?:[ \t]{0,3}(`{3,}|~{3,})|[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t\r\n]|(?![\s\S])))/gm
const FRONT_MATTER_OPEN = /^---[ \t]*(?:\r\n?|\n|(?![\s\S]))/
const FRONT_MATTER_CLOSE = /(?:\r\n?|\n)---[ \t]*(?:\r\n?|\n|(?![\s\S]))/g

export interface TaskProgress {
  done: number
  total: number
}

/** Front matter and code blocks hold none. */
export function taskProgress(markdown: string): TaskProgress {
  let start = 0
  const open = FRONT_MATTER_OPEN.exec(markdown)
  if (open) {
    FRONT_MATTER_CLOSE.lastIndex = open[0].length - 1
    if (FRONT_MATTER_CLOSE.exec(markdown)) start = FRONT_MATTER_CLOSE.lastIndex
  }
  let done = 0
  let total = 0
  let fence: string | undefined
  const lines = new RegExp(TASK_LINES)
  lines.lastIndex = start
  for (let found = lines.exec(markdown); found; found = lines.exec(markdown)) {
    const before = markdown.charCodeAt(found.index - 1)
    if (before === 0x2028 || before === 0x2029) {
      lines.lastIndex = found.index + 1
      continue
    }
    const marks = found[1]
    if (fence !== undefined) {
      if (marks && marks[0] === fence[0] && marks.length >= fence.length) fence = undefined
      continue
    }
    if (marks) {
      fence = marks
      continue
    }
    total += 1
    if (found[2] !== ' ') done += 1
  }
  return { done, total }
}
