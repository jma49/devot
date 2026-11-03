// Wiki-style links in imported Markdown: `[[Title]]`, `[[folder/Title#Heading|Shown]]` and embeds such as `![[image.png|300]]`.
// Import (import.ts) turns the ones it can match into note links and image attachments; the rest stay as written.
import type { Nodes, Root } from 'mdast'
import { altWithSize, type ImageSize } from './images'
import { linkText } from './links'

export interface WikiLink {
  start: number
  end: number
  embed: boolean
  inner: string
}

export interface WikiTarget {
  /** The written path without a `.md` extension: `folder/Title`; empty for a heading of the same note. */
  path: string
  name: string
  heading: string | null
  alias: string | null
  /** An embed's `|300` or `|300x200` width in pixels. */
  width: number | null
}

/** Nothing inside these is a wiki link: code, math, raw HTML, front matter, and the text and destination of a Markdown link or image. */
const OPAQUE = new Set([
  'code',
  'inlineCode',
  'math',
  'inlineMath',
  'html',
  'yaml',
  'link',
  'image',
  'linkReference',
  'imageReference',
  'definition',
])

const WIKI = /(!?)\[\[([^[\]\n]+)\]\]/g

export function wikiLinksOf(tree: Root, markdown: string): WikiLink[] {
  if (!markdown.includes('[[')) return []
  const opaque: [number, number][] = []
  const walk = (node: Nodes) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (OPAQUE.has(node.type) && start !== undefined && end !== undefined) {
      opaque.push([start, end])
      return
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes)
  }
  walk(tree)
  const links: WikiLink[] = []
  for (const match of markdown.matchAll(WIKI)) {
    const start = match.index
    const end = start + match[0].length
    const bracket = start + match[1]!.length
    if (escaped(markdown, bracket)) continue
    if (opaque.some(([from, to]) => from < end && start < to)) continue
    links.push({ start, end, embed: match[1] === '!', inner: match[2]! })
  }
  return links
}

function escaped(text: string, at: number): boolean {
  let slashes = 0
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1
  return slashes % 2 === 1
}

const SIZE = /^(\d{1,5})(?:x\d{1,5})?$/

/** A `|` written `\|` (inside a table) separates as `|` does. */
export function parseWikiTarget(inner: string, embed: boolean): WikiTarget {
  const parts = inner.split(/\\?\|/).map((part) => part.trim())
  const head = parts[0]!
  let width: number | null = null
  let alias: string | null = null
  for (const part of parts.slice(1)) {
    const size = embed ? SIZE.exec(part) : null
    if (size) width = Number(size[1])
    else if (alias === null && part !== '') alias = part
  }
  const hash = head.indexOf('#')
  const written = hash === -1 ? head : head.slice(0, hash)
  const heading = hash === -1 ? null : head.slice(hash + 1).trim() || null
  const path = written.trim().replace(/\.md$/i, '')
  return { path, name: path.split('/').pop()!.trim(), heading, alias, width }
}

/** Case and diacritics (combining marks after a Latin, Greek or Cyrillic letter) do not count, nor runs of spaces. Other scripts' marks stay: they change the character. */
export function titleKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** The note column's width, `size.reading-width`: Half and Full are read against it. */
const READING_WIDTH_PX = 740

const PRESET_PX: [Exclude<ImageSize, 'auto'>, number][] = [
  ['small', 240],
  ['half', READING_WIDTH_PX / 2],
  ['full', READING_WIDTH_PX],
]

export function nearestImageSize(width: number | null): ImageSize {
  if (width === null) return 'auto'
  let best = PRESET_PX[0]!
  for (const preset of PRESET_PX) {
    if (Math.abs(preset[1] - width) < Math.abs(best[1] - width)) best = preset
  }
  return best[0]
}

export function wikiShownText(target: WikiTarget): string {
  if (target.alias !== null) return target.alias
  return target.heading === null ? target.name : `${target.name}#${target.heading}`
}

export function embeddedImage(target: WikiTarget, uri: string): string {
  const alt = linkText(target.alias ?? '')
  return `![${altWithSize(alt, nearestImageSize(target.width))}](${uri})`
}
