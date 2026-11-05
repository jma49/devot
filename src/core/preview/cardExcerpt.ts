// Where a gallery card's page thumbnail stops: the start of a note's body, at
// whole blocks (see blocks.ts), so the card renders a few hundred characters
// whatever the note holds.
import { lineHeadline, repeatsTitle } from '../extract'
import { splitBlocks } from './blocks'

export const CARD_EXCERPT_CHARS = 1200
export const CARD_EXCERPT_BLOCKS = 12
export const CARD_EXCERPT_LINES = 40
/** How much of a body is looked at at all: whatever a note holds after it never costs anything. */
const READ_CHARS = CARD_EXCERPT_CHARS * 4

const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,}|\${2,})/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/

/** `lines` with a code or math fence they leave open closed again. */
function closeFences(lines: readonly string[]): string[] {
  let open: string | null = null
  for (const line of lines) {
    const mark = FENCE.exec(line)?.[1]
    if (!mark) continue
    if (open === null) open = mark
    else if (mark[0] === open[0] && mark.length >= open.length) open = null
  }
  return open === null ? [...lines] : [...lines, open]
}

/** The start of `text` (one block) that fits the caps, cut at whole lines when it can be. */
function cutBlock(text: string, chars: number, lines: number): string {
  const out: string[] = []
  let used = 0
  for (const line of text.split('\n')) {
    if (out.length >= lines || used + line.length > chars) break
    out.push(line)
    used += line.length + 1
  }
  if (out.length === 0) return text.slice(0, chars)
  return closeFences(out).join('\n')
}

/** Where `body` starts after an opening line the card already shows as its title (with a setext underline and blank lines after it). */
function titleLineEnd(body: string, title: string): number {
  const lines = body.slice(0, READ_CHARS).split('\n')
  let at = 0
  let index = 0
  const skip = () => (at += lines[index++]!.length + 1)
  while (index < lines.length && lines[index]!.trim() === '') skip()
  if (index >= lines.length || !repeatsTitle(lineHeadline(lines[index]!), title)) return 0
  skip()
  if (SETEXT_UNDERLINE.test(lines[index] ?? '')) skip()
  while (index < lines.length - 1 && lines[index]!.trim() === '') skip()
  return Math.min(at, body.length)
}

/**
 * The Markdown a gallery card shows: the body after its front matter and an
 * opening line that repeats `title` (as `listExcerpt` leaves it out), as many
 * whole top-level blocks as fit `CARD_EXCERPT_CHARS`, `CARD_EXCERPT_BLOCKS`
 * and `CARD_EXCERPT_LINES`. A first block too long for them is cut at a line,
 * and a code fence it cuts is closed. Only the first `READ_CHARS` are read.
 */
export function cardExcerpt(markdown: string, title: string): string {
  const content = markdown.startsWith('---') ? markdown.replace(FRONT_MATTER, '') : markdown
  const body = content.slice(titleLineEnd(content, title))
  const head = body.slice(0, READ_CHARS)
  const lineCount = (text: string) => text.split('\n').length
  if (head.length === body.length && body.length <= CARD_EXCERPT_CHARS) {
    if (lineCount(body) <= CARD_EXCERPT_LINES) {
      const blocks = splitBlocks(body)
      if (blocks.length <= CARD_EXCERPT_BLOCKS) return body
    }
  }
  const blocks = splitBlocks(head)
  let out = ''
  let lines = 0
  for (const [index, block] of blocks.entries()) {
    const text = block.text
    const blockLines = lineCount(text.trimEnd())
    const fits =
      index < CARD_EXCERPT_BLOCKS &&
      out.length + text.length <= CARD_EXCERPT_CHARS &&
      lines + blockLines <= CARD_EXCERPT_LINES
    if (!fits) {
      if (index === 0) return cutBlock(text.trimEnd(), CARD_EXCERPT_CHARS, CARD_EXCERPT_LINES)
      break
    }
    out += text
    lines += blockLines
  }
  return out.trimEnd()
}
