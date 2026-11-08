// New Note from Selection: selected text moves into a note of its own, titled after its first line (see NoteService.extract).

import { clipTitle } from './noteLimits'
import { readFence, type Fence } from './fences'
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
const LIST_EXCERPT_CHARS = 200

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
// a line that may be a code fence (group 1) or a task item (group 2). Multiline `^` also follows
// U+2028 and U+2029, which do not end a line here, and the CR of a CRLF, so a match there is passed over.
const TASK_LINES =
  /^(?:((?: {0,3}>[ \t]?)* {0,3}(?:`{3,}|~{3,})[^\n\r]*)|[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t\r\n]|(?![\s\S])))/gm
// Every line, read while a quoted code block is open: any line can end its quote.
const EVERY_LINE = /^[^\n\r]*/gm
const FRONT_MATTER_OPEN = /^---[ \t]*(?:\r\n?|\n|(?![\s\S]))/
const FRONT_MATTER_CLOSE = /(?:\r\n?|\n)---[ \t]*(?:\r\n?|\n|(?![\s\S]))/g

export interface TaskProgress {
  done: number
  total: number
}

/** Where the body of `markdown` starts: after its front matter, when it has some. */
export function frontMatterEnd(markdown: string): number {
  const open = FRONT_MATTER_OPEN.exec(markdown)
  if (!open) return 0
  const close = new RegExp(FRONT_MATTER_CLOSE)
  close.lastIndex = open[0].length - 1
  return close.exec(markdown) ? close.lastIndex : 0
}

/**
 * The task items in `text`, which starts at the start of a line, read with the code fence
 * `fence` open; and the fence open at its end.
 */
export function tasksIn(text: string, fence?: Fence): TaskProgress & { fence: Fence | undefined } {
  let done = 0
  let total = 0
  const lines = new RegExp(TASK_LINES)
  const quotedCode = new RegExp(EVERY_LINE)
  let scan = fence?.depth ? quotedCode : lines
  for (let found = scan.exec(text); found; found = scan.exec(text)) {
    const before = text.charCodeAt(found.index - 1)
    const inLineBreak = before === 0x0d && text.charCodeAt(found.index) === 0x0a
    if (before === 0x2028 || before === 0x2029 || inLineBreak) {
      scan.lastIndex = found.index + 1
      continue
    }
    if (scan === quotedCode) {
      const read = readFence(found[0], fence)
      fence = read.fence
      if (!read.code) {
        lines.lastIndex = found.index
        scan = lines
      } else if (!fence?.depth) {
        lines.lastIndex = scan.lastIndex
        scan = lines
      }
      continue
    }
    const line = found[1]
    if (line !== undefined || fence !== undefined) {
      if (line !== undefined) fence = readFence(line, fence).fence
      if (fence?.depth) {
        quotedCode.lastIndex = scan.lastIndex
        scan = quotedCode
      }
      continue
    }
    total += 1
    if (found[2] !== ' ') done += 1
  }
  return { done, total, fence }
}

/** Front matter and code blocks hold none. */
export function taskProgress(markdown: string): TaskProgress {
  const start = frontMatterEnd(markdown)
  const { done, total } = tasksIn(start > 0 ? markdown.slice(start) : markdown)
  return { done, total }
}
