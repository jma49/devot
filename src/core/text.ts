// Plain-text helpers: replacing ranges, the smallest single replacement
// between two texts (applied to Yjs documents as operations), whitespace and
// code point counts as Rust reads them, and filling `{name}` placeholders.

/**
 * The text with every line break as `\n` (`\r\n` and a lone `\r` become
 * `\n`). The editor counts a CRLF as one character and the Yjs text as two,
 * so a body must never hold `\r` or edits would land in the wrong place.
 */
export function lineFeeds(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export interface TextEdit {
  start: number
  end: number
  text: string
}

/** Applies non-overlapping replacements; the rest of the text is untouched. */
export function replaceRanges(text: string, edits: readonly TextEdit[]): string {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * The single replacement that turns `from` into `to`: everything between
 * their common prefix and suffix. It never splits a surrogate pair.
 */
export function textDiff(
  from: string,
  to: string,
): { index: number; remove: number; insert: string } {
  const max = Math.min(from.length, to.length)
  let prefix = 0
  while (prefix < max && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1
  if (prefix > 0 && prefix < max && isHigh(from.charCodeAt(prefix - 1))) prefix -= 1
  let suffix = 0
  while (
    suffix < max - prefix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix += 1
  }
  if (suffix > 0 && isLow(from.charCodeAt(from.length - suffix))) suffix -= 1
  return {
    index: prefix,
    remove: from.length - prefix - suffix,
    insert: to.slice(prefix, to.length - suffix),
  }
}

/**
 * Whitespace as Unicode's White_Space property (and Rust's
 * `char::is_whitespace`) has it: JavaScript's `trim()` also strips U+FEFF
 * and keeps U+0085, Rust does neither. Names, excerpts and every check that
 * Rust repeats use this rule.
 */
export function isWhitespace(c: string): boolean {
  // Spelled out (the 25 characters of White_Space): this runs per character
  // on whole note bodies, where a regular expression per call is slow.
  if (c.length !== 1) return false
  const code = c.charCodeAt(0)
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  )
}

/** `text` without leading and trailing whitespace (as Rust's `str::trim`). */
export function trimWhitespace(text: string): string {
  // Every whitespace character is one UTF-16 unit, so a surrogate never matches.
  let start = 0
  let end = text.length
  while (start < end && isWhitespace(text[start]!)) start++
  while (end > start && isWhitespace(text[end - 1]!)) end--
  return text.slice(start, end)
}

/** How many code points `text` holds (as Rust's `chars().count()`). */
export const charCount = (text: string): number => [...text].length

/** The first `max` code points of `text`; a surrogate pair is never split. */
export function clipChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('') : text
}

/**
 * `template` with each `{name}` replaced by `values[name]`, in one pass: a
 * value is inserted as plain text and never read again, so a value holding
 * `$&`, `$$` or braces shows as typed. Placeholders without a value stay.
 */
export function fillPlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : slot,
  )
}
