// Images in a note: their size preset and where an inline image's parts are.
//
// A size is stored in the image's URL as a fragment: `![](devot://file/<id>#small)`,
// `#half` or `#full`; no fragment is `auto` (the image's own size, no wider
// than the page). Other Markdown tools ignore a fragment when they load an
// image, so the note still shows the image there, at its own size.

import { FILE_ID_SOURCE, fileUri } from './files'

export type ImageSize = 'auto' | 'small' | 'half' | 'full'

export const IMAGE_SIZES: readonly ImageSize[] = ['auto', 'small', 'half', 'full']

const SIZE_FRAGMENT = /#(small|half|full)$/

/** A URL's size preset and the URL without it. */
export function splitImageSize(url: string): { url: string; size: ImageSize } {
  const match = SIZE_FRAGMENT.exec(url)
  return match
    ? { url: url.slice(0, match.index), size: match[1] as ImageSize }
    : { url, size: 'auto' }
}

/** `url` (without a size) with a size preset; auto adds nothing. */
export function withImageSize(url: string, size: ImageSize): string {
  return size === 'auto' ? url : `${url}#${size}`
}

/** A size at the end of a destination as written; `\#small` is `#small` there too. */
const WRITTEN_SIZE = /(\\*)#(small|half|full)$/

/**
 * A destination's size as written in Markdown, and the text before it. A
 * backslash escaping the `#` goes with the size, so writing another size (or
 * none) leaves no stray escape before the closing parenthesis.
 */
function splitWrittenSize(dest: string): { url: string; size: ImageSize } {
  const match = WRITTEN_SIZE.exec(dest)
  if (!match) return { url: dest, size: 'auto' }
  // Pairs of backslashes are literal backslashes; an odd one out escapes the `#`.
  const slashes = match[1]!.length
  return { url: dest.slice(0, match.index + slashes - (slashes % 2)), size: match[2] as ImageSize }
}

const ATTACHMENT = new RegExp(`^${fileUri(`(${FILE_ID_SOURCE})`)}$`)

/** The attachment ID an image URL shows (with or without a size), or null. */
export function attachmentId(url: string): string | null {
  return ATTACHMENT.exec(splitImageSize(url).url)?.[1] ?? null
}

export interface ImageMarkdown {
  /** The alt text as written (escapes kept). */
  alt: string
  /** The destination without its size (and without angle brackets). */
  url: string
  size: ImageSize
  /** Whether a size can be set: the URL has no other fragment. */
  sizable: boolean
  /** Where the destination's text (inside any angle brackets) starts and ends. */
  dest: { from: number; to: number }
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** The index after a title (`"…"`, `'…'` or `(…)`) starting at `at`, or -1. */
function titleEnd(text: string, at: number): number {
  const open = text[at]
  const close = open === '"' ? '"' : open === "'" ? "'" : open === '(' ? ')' : undefined
  if (close === undefined) return -1
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1
    else if (text[i] === close) return i + 1
    else if (open === '(' && text[i] === '(') return -1
  }
  return -1
}

/**
 * Reads `text` as exactly one inline image, `![alt](destination "title")`;
 * null for anything else (a reference image `![alt][ref]` too, since its
 * destination is elsewhere).
 */
export function parseImageMarkdown(text: string): ImageMarkdown | null {
  if (!text.startsWith('![')) return null
  // The alt text: brackets may nest; a backslash escapes the next character.
  let i = 2
  for (let depth = 1; depth > 0; i += 1) {
    const c = text[i]
    if (c === undefined) return null
    if (c === '\\') i += 1
    else if (c === '[') depth += 1
    else if (c === ']') depth -= 1
  }
  const alt = text.slice(2, i - 1)
  if (text[i] !== '(' || !text.endsWith(')')) return null
  const end = text.length - 1
  i += 1
  while (isSpace(text[i])) i += 1
  let from: number
  let to: number
  if (text[i] === '<') {
    from = i + 1
    to = text.indexOf('>', from)
    if (to < 0 || /[<\n]/.test(text.slice(from, to))) return null
    i = to + 1
  } else {
    from = i
    let depth = 0
    for (; i < end; i += 1) {
      const c = text[i]!
      if (c === '\\') i += 1
      else if (isSpace(c) || c.charCodeAt(0) < 0x20) break
      else if (c === '(') depth += 1
      else if (c === ')') {
        if (depth === 0) break
        depth -= 1
      }
    }
    to = Math.min(i, end)
    if (depth !== 0) return null
  }
  if (to === from) return null
  // What follows the destination: spaces, an optional title, spaces.
  let rest = i
  while (isSpace(text[rest])) rest += 1
  if (rest < end) {
    if (rest === i) return null
    rest = titleEnd(text, rest)
    if (rest < 0) return null
    while (isSpace(text[rest])) rest += 1
  }
  if (rest !== end) return null
  const { url, size } = splitWrittenSize(text.slice(from, to))
  return { alt, url, size, sizable: !url.includes('#'), dest: { from, to } }
}

/**
 * The image's Markdown with this size, changing only its destination; null
 * when `text` is not one inline image or its URL cannot take a size.
 */
export function setImageMarkdownSize(text: string, size: ImageSize): string | null {
  const image = parseImageMarkdown(text)
  if (!image?.sizable) return null
  const { from, to } = image.dest
  return text.slice(0, from) + withImageSize(image.url, size) + text.slice(to)
}
