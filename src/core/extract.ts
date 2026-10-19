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
    const text = readableText(lineTitle(line))
    if (text !== '') return [...text].slice(0, HEADLINE_CHARS).join('')
  }
  return ''
}

const EXCERPT_SCAN_CHARS = 2000
export const LIST_EXCERPT_CHARS = 200

/** For a note with no title the first line is its headline, so the excerpt starts after it. Empty when nothing is left. */
export function listExcerpt(markdown: string, title: string): string {
  let text = readableText(markdown.slice(0, EXCERPT_SCAN_CHARS))
  if (title === '') {
    const first = headline(markdown)
    if (first !== '' && text.startsWith(first)) text = text.slice(first.length).trim()
  }
  return [...text].slice(0, LIST_EXCERPT_CHARS).join('')
}

const TASK_ITEM = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/

export interface TaskProgress {
  done: number
  total: number
}

/** Front matter and code blocks hold none. */
export function taskProgress(markdown: string): TaskProgress {
  const lines = markdown.split(/\r\n?|\n/)
  let first = 0
  if (FRONT_MATTER_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_FENCE.test(l))
    if (close > 0) first = close + 1
  }
  let done = 0
  let total = 0
  let fence: string | undefined
  for (const line of lines.slice(first)) {
    const marks = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (marks && marks[0] === fence[0] && marks.length >= fence.length) fence = undefined
      continue
    }
    if (marks) {
      fence = marks
      continue
    }
    const task = TASK_ITEM.exec(line)
    if (!task) continue
    total += 1
    if (task[1] !== ' ') done += 1
  }
  return { done, total }
}
