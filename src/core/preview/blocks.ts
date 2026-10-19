// Where a note can be cut into pieces that parse on their own exactly as they
// do in the whole note, so the preview re-renders only the pieces that change.
// A cut is made only at a blank line followed by a line that can only start a
// new top-level block. When in doubt the piece grows: a note with a link
// reference or footnote definition (they reach across the whole note) is one
// piece.

export interface Block {
  text: string
  /** Where `text` starts in the note: offset and 1-based line. */
  offset: number
  line: number
}

const DEFINITION = /^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])[ \t])*\[(?:[^\]\\]|\\[\s\S]){1,999}\]:/m
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const MATH = /^ {0,3}(\${2,})(.*)$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const BLANK = /^[ \t]*$/
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/g
const CODE_SPAN = /(`+)[^`]*?\1/g
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
/** Raw HTML whose end may come after a blank line. */
const SPANS: readonly [string, string][] = [
  ['<!--', '-->'],
  ['<?', '?>'],
  ['<![CDATA[', ']]>'],
]

/** Open HTML elements a line leaves, after `depth` before it; its comment, if one stays open, comes back as its end marker. */
function htmlAfter(line: string, depth: number): { depth: number; until: string | null } {
  let text = line.replace(CODE_SPAN, '')
  for (const [open, close] of SPANS) {
    let at = text.indexOf(open)
    while (at >= 0) {
      const end = text.indexOf(close, at + open.length)
      if (end < 0) return { depth: Math.max(0, depth + tagsIn(text.slice(0, at))), until: close }
      text = text.slice(0, at) + text.slice(end + close.length)
      at = text.indexOf(open, at)
    }
  }
  return { depth: Math.max(0, depth + tagsIn(text)), until: null }
}

function tagsIn(text: string): number {
  let change = 0
  for (const match of text.matchAll(TAG)) {
    if (match.index > 0 && text[match.index - 1] === '\\') continue
    const name = match[2]!.toLowerCase()
    if (match[1]) {
      change -= 1
      continue
    }
    if (VOID.has(name)) continue
    const end = text.indexOf('>', match.index)
    if (end > 0 && text[end - 1] === '/') continue
    change += 1
  }
  return change
}

/** Pieces are at least `minLength` long (bar the last): each piece costs some setting up. */
export function splitBlocks(markdown: string, minLength = 1): Block[] {
  if (DEFINITION.test(markdown)) return [{ text: markdown, offset: 0, line: 1 }]
  const blocks: Block[] = []
  let start = 0
  let startLine = 1
  let fence: { char: string; size: number } | null = null
  let math = 0
  let frontmatter = false
  let until: string | null = null
  let depth = 0
  let afterBlank = false

  let line = 1
  for (let at = 0; at <= markdown.length; line += 1) {
    const next = markdown.indexOf('\n', at)
    const end = next < 0 ? markdown.length : next
    const text = markdown.slice(at, markdown[end - 1] === '\r' ? end - 1 : end)

    if (frontmatter) {
      if (text === '---') frontmatter = false
    } else if (fence) {
      const close = FENCE.exec(text)
      if (
        close?.[1]?.[0] === fence.char &&
        close[1].length >= fence.size &&
        BLANK.test(close[2] ?? '')
      ) {
        fence = null
      }
    } else if (math > 0) {
      const close = MATH.exec(text)
      if (close?.[1] && close[1].length >= math && BLANK.test(close[2] ?? '')) math = 0
    } else if (until !== null) {
      const closed = text.indexOf(until)
      if (closed >= 0) {
        const after = htmlAfter(text.slice(closed + until.length), depth)
        until = after.until
        depth = after.depth
      }
    } else if (BLANK.test(text)) {
      afterBlank = true
    } else {
      if (
        afterBlank &&
        at - start >= minLength &&
        depth === 0 &&
        text[0] !== ' ' &&
        text[0] !== '\t' &&
        !LIST_ITEM.test(text)
      ) {
        blocks.push({ text: markdown.slice(start, at), offset: start, line: startLine })
        start = at
        startLine = line
      }
      afterBlank = false
      const open = FENCE.exec(text)
      const opensMath = MATH.exec(text)
      if (at === 0 && text === '---') frontmatter = true
      else if (open?.[1] && !(open[1][0] === '`' && open[2]?.includes('`'))) {
        fence = { char: open[1][0]!, size: open[1].length }
      } else if (opensMath?.[1] && !opensMath[2]?.includes('$')) {
        math = opensMath[1].length
      } else {
        const after = htmlAfter(text, depth)
        until = after.until
        depth = after.depth
      }
    }
    if (next < 0) break
    at = next + 1
  }
  blocks.push({ text: markdown.slice(start), offset: start, line: startLine })
  return blocks
}
