// Images in a note: their size and where an inline image's parts are.
//
// A size is written at the end of the image's alt text: `![name w:240](url)`. The presets are Small (`w:240`), Half (`w:50%`) and Full (`w:100%`); no size is `auto`.
// The alt text also takes `width:`/`height:` (or `w:`/`h:`) with a number in px (bare), %, pt, pc, in, cm, mm, em, ex or ch, as in `w:320 h:240`.
// Older notes store a preset as a URL fragment (`#small`, `#half`, `#full`); those still read, and setting a size rewrites them to the alt form.

import { FILE_ID_SOURCE, fileUri } from './files'

export type ImageSize = 'auto' | 'small' | 'half' | 'full'

export const IMAGE_SIZES: readonly ImageSize[] = ['auto', 'small', 'half', 'full']

const PRESET_WORDS: Record<Exclude<ImageSize, 'auto'>, string> = {
  small: '240',
  half: '50%',
  full: '100%',
}

const PRESET_WIDTHS: Record<Exclude<ImageSize, 'auto'>, string> = {
  small: '240px',
  half: '50%',
  full: '100%',
}

export interface ImageDimensions {
  width?: string
  height?: string
}

const SIZE_WORD = /^(w|width|h|height):(\d+(?:\.\d+)?|\.\d+)(%|px|pt|pc|in|cm|mm|em|ex|ch)?$/i

/** A later word for the same side wins. Words before the last non-size word are part of the name. */
export function splitAltSize(alt: string): { name: string; dimensions: ImageDimensions | null } {
  const words = alt.split(/([ \t\n]+)/)
  const dimensions: ImageDimensions = {}
  let end = words.length
  // Walks back over the trailing size words (and the spaces between them).
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!
    if (word === '' || /^[ \t\n]+$/.test(word)) continue
    const match = SIZE_WORD.exec(word)
    if (!match) break
    const side = match[1]!.toLowerCase().startsWith('w') ? 'width' : 'height'
    dimensions[side] ??= `${match[2]}${(match[3] ?? 'px').toLowerCase()}`
    end = i
  }
  if (end === words.length) return { name: alt, dimensions: null }
  return {
    name: words
      .slice(0, end)
      .join('')
      .replace(/[ \t\n]+$/, ''),
    dimensions,
  }
}

export function presetOf(dimensions: ImageDimensions): ImageSize | null {
  if (dimensions.height !== undefined) return null
  for (const [size, width] of Object.entries(PRESET_WIDTHS)) {
    if (dimensions.width === width) return size as ImageSize
  }
  return null
}

export function altWithSize(name: string, size: ImageSize): string {
  if (size === 'auto') return name
  const word = `w:${PRESET_WORDS[size]}`
  return name === '' ? word : `${name} ${word}`
}

const SIZE_FRAGMENT = /#(small|half|full)$/

export function splitImageSize(url: string): { url: string; size: ImageSize } {
  const match = SIZE_FRAGMENT.exec(url)
  return match
    ? { url: url.slice(0, match.index), size: match[1] as ImageSize }
    : { url, size: 'auto' }
}

export function withImageSize(url: string, size: ImageSize): string {
  return size === 'auto' ? url : `${url}#${size}`
}

const WRITTEN_SIZE = /(\\*)#(small|half|full)$/

/** A backslash escaping the `#` goes with the size, so writing another size (or none) leaves no stray escape before the closing parenthesis. */
function splitWrittenSize(dest: string): { url: string; size: ImageSize } {
  const match = WRITTEN_SIZE.exec(dest)
  if (!match) return { url: dest, size: 'auto' }
  // Pairs of backslashes are literal backslashes; an odd one out escapes the `#`.
  const slashes = match[1]!.length
  return { url: dest.slice(0, match.index + slashes - (slashes % 2)), size: match[2] as ImageSize }
}

const ATTACHMENT = new RegExp(`^${fileUri(`(${FILE_ID_SOURCE})`)}$`)

export function attachmentId(url: string): string | null {
  return ATTACHMENT.exec(splitImageSize(url).url)?.[1] ?? null
}

export interface ImageMarkdown {
  alt: string
  url: string
  size: ImageSize
  dimensions: ImageDimensions | null
  sizable: boolean
  altRange: { from: number; to: number }
  dest: { from: number; to: number }
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

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

/** Null for anything else, a reference image `![alt][ref]` too (its destination is elsewhere). */
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
  const written = splitWrittenSize(text.slice(from, to))
  const { name, dimensions } = splitAltSize(alt)
  const preset = dimensions ? presetOf(dimensions) : null
  return {
    alt: name,
    url: written.url,
    size: dimensions ? (preset ?? 'auto') : written.size,
    dimensions: dimensions && !preset ? dimensions : null,
    sizable: true,
    altRange: { from: 2, to: 2 + alt.length },
    dest: { from, to },
  }
}

/** The text is unchanged when it already has that size; null when it is not one inline image. */
export function setImageMarkdownSize(text: string, size: ImageSize): string | null {
  const image = parseImageMarkdown(text)
  if (!image) return null
  if (image.size === size && image.dimensions === null) return text
  const { altRange, dest } = image
  return (
    text.slice(0, altRange.from) +
    altWithSize(image.alt, size) +
    text.slice(altRange.to, dest.from) +
    image.url +
    text.slice(dest.to)
  )
}

const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  em: 16,
  ex: 8,
  ch: 8,
}

/** A percentage as it is, anything else in whole pixels. */
export function sizeAttribute(length: string): string {
  const match = /^([\d.]+)([a-z%]+)$/.exec(length)
  if (!match) return length
  const value = Number(match[1])
  if (match[2] === '%') return `${value}%`
  return String(Math.round(value * (PX_PER_UNIT[match[2]!] ?? 1)))
}
