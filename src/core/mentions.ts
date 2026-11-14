// Unlinked mentions: a note's title written as plain text in another note's body, which could be
// a note link. Text that is not prose never counts: front matter, code, HTML, links and their
// addresses, images and URLs. In a script written with spaces the title must stand as whole words;
// in Chinese, Japanese or Thai, which run words together, anywhere in the text.
import { frontMatterEnd } from './extract'
import { readFence, type Fence } from './fences'
import { escapeRegExp, indexable } from './search'

export interface Mention {
  from: number
  to: number
}

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u
const WORD = /[\p{L}\p{N}_]/u

const NOT_PROSE = [
  /(`+)[^`]*?\1/g,
  /!?\[(?:[^\]\\\n]|\\.)*\]\([^)\n]*\)/g,
  /!?\[(?:[^\]\\\n]|\\.)*\]\[[^\]\n]*\]/g,
  /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:.*$/gm,
  /<!--[\s\S]*?-->/g,
  /<[^>\n]+>/g,
  /\b(?:https?|mailto|devot):[^\s<>)\]]+/gi,
]

/** A title can be looked for when it is long enough for the search index. */
export const mentionable = (title: string): boolean => indexable(title.trim())

function codeLines(body: string, from: number, out: [number, number][]): void {
  let fence: Fence | undefined
  let at = from
  while (at < body.length) {
    const end = body.indexOf('\n', at)
    const stop = end < 0 ? body.length : end
    const read = readFence(body.slice(at, stop), fence)
    if (read.code) out.push([at, stop])
    fence = read.fence
    at = stop + 1
  }
}

/** The spans of `body` that are not prose, sorted. */
function skipped(body: string): [number, number][] {
  const start = frontMatterEnd(body)
  const out: [number, number][] = start > 0 ? [[0, start]] : []
  codeLines(body, start, out)
  for (const pattern of NOT_PROSE) {
    for (const match of body.matchAll(pattern))
      out.push([match.index, match.index + match[0].length])
  }
  return out.sort((a, b) => a[0] - b[0])
}

const covered = (spans: readonly [number, number][], from: number, to: number) =>
  spans.some(([a, b]) => a < to && from < b)

function standsAlone(body: string, title: string, from: number, to: number): boolean {
  const first = title[0]!
  const last = title.at(-1)!
  const before = body.slice(Math.max(0, from - 2), from)
  const after = body.slice(to, to + 2)
  const touching = (side: string, edge: string, end: boolean) => {
    const char = end ? [...side].at(-1) : [...side][0]
    return char !== undefined && WORD.test(char) && !UNSPACED.test(edge) && !UNSPACED.test(char)
  }
  return !touching(before, first, true) && !touching(after, last, false)
}

/** The first place `body` mentions `title` as text, or null. */
export function findMention(body: string, title: string): Mention | null {
  const name = title.trim()
  if (!mentionable(name)) return null
  const pattern = new RegExp(name.split(/\s+/).map(escapeRegExp).join('\\s+'), 'giu')
  let spans: [number, number][] | undefined
  for (const match of body.matchAll(pattern)) {
    const from = match.index
    const to = from + match[0].length
    if (!standsAlone(body, name, from, to)) continue
    spans ??= skipped(body)
    if (!covered(spans, from, to)) return { from, to }
  }
  return null
}

/** The line around a mention, at most `chars` long, for a list to show. */
export function mentionExcerpt(body: string, mention: Mention, chars = 120): string {
  const lineStart = body.lastIndexOf('\n', mention.from - 1) + 1
  const lineEnd = body.indexOf('\n', mention.to)
  const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd)
  const at = mention.from - lineStart
  const from = Math.max(0, Math.min(at - Math.floor(chars / 3), line.length - chars))
  const shown = line.slice(from, from + chars).trim()
  return `${from > 0 ? '…' : ''}${shown}${from + chars < line.length ? '…' : ''}`
}
