// Where a gallery card's page thumbnail stops: the start of a note's body, at
// whole blocks (see blocks.ts), so the card renders a few hundred characters
// whatever the note holds.
import { splitBlocks } from './blocks'

export const CARD_EXCERPT_CHARS = 1200
export const CARD_EXCERPT_BLOCKS = 12
export const CARD_EXCERPT_LINES = 40
/** How much of a body is looked at at all: whatever a note holds after it never costs anything. */
const READ_CHARS = CARD_EXCERPT_CHARS * 4

const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,}|\${2,})/

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

/**
 * The Markdown a gallery card shows: the body after its front matter, as many
 * whole top-level blocks as fit `CARD_EXCERPT_CHARS`, `CARD_EXCERPT_BLOCKS`
 * and `CARD_EXCERPT_LINES`. A first block too long for them is cut at a line,
 * and a code fence it cuts is closed. Only the first `READ_CHARS` are read.
 */
export function cardExcerpt(markdown: string): string {
  const body = markdown.startsWith('---') ? markdown.replace(FRONT_MATTER, '') : markdown
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
