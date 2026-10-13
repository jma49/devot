// What storage takes in a note: the limits the app's note_put checks
// (src-tauri/src/commands/notes.rs; a policy test checks they match). The
// core cuts titles to fit before they reach storage (clipTitle), so typing
// or pasting a long title never stops a note from saving; every storage
// adapter refuses a record outside the limits with note_put's codes
// (checkNote), so the core and its tests see the refusals the app would.

import { MAX_NOTE_LINKS, noteLinks } from './links'
import type { NoteRecord } from './storage'

/** The longest title a note may have, in code points (Rust counts characters). */
export const MAX_TITLE_CHARS = 1000
/** The largest Markdown body a note may have, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024
/** The largest Yjs state a note may have, in bytes. */
export const MAX_YDOC_BYTES = 64 * 1024 * 1024

/** A link is `devot://note/` and a UUID: a body shorter than this many characters holds too few. */
const LINK_CHARS = 'devot://note/'.length + 36

/**
 * Where `text` ends once cut to `max` code points: its length when it has no
 * more (a code point is one or two UTF-16 units, and a lone surrogate counts
 * as one, as it does once it reaches Rust).
 */
function cutAt(text: string, max: number): number {
  if (text.length <= max) return text.length
  let count = 0
  let end = 0
  for (const char of text) {
    if (count === max) break
    count += 1
    end += char.length
  }
  return end
}

/**
 * `title` as a title storage takes: each line break becomes a space, and it
 * is cut to MAX_TITLE_CHARS code points (never inside a surrogate pair).
 * Anything else stays as typed, spaces included.
 */
export function clipTitle(title: string): string {
  const line = title.replace(/\r\n?|\n/g, ' ')
  return line.slice(0, cutAt(line, MAX_TITLE_CHARS))
}

/** Whether `text` takes more than `max` bytes in UTF-8. */
function overBytes(text: string, max: number): boolean {
  // A UTF-16 unit is at most three bytes in UTF-8: count only when it may not fit.
  if (text.length * 3 <= max) return false
  return new TextEncoder().encode(text).length > max
}

/**
 * Throws the code note_put refuses `note` with when its title, body, Yjs
 * state or note links (`links`, the body's by default) are outside the
 * limits.
 */
export function checkNote(note: NoteRecord, links?: readonly string[]): void {
  const { title, bodyMd, ydoc } = note
  if (/[\r\n]/.test(title) || cutAt(title, MAX_TITLE_CHARS) < title.length) {
    throw new Error('E_NOTE_TITLE_INVALID')
  }
  if (overBytes(bodyMd, MAX_BODY_BYTES)) throw new Error('E_NOTE_BODY_TOO_LARGE')
  if (ydoc.length === 0 || ydoc.length > MAX_YDOC_BYTES) throw new Error('E_NOTE_YDOC_INVALID')
  if (bodyMd.length <= MAX_NOTE_LINKS * LINK_CHARS) return
  if ((links ?? noteLinks(bodyMd)).length > MAX_NOTE_LINKS) throw new Error('E_NOTE_LINKS_TOO_MANY')
}
