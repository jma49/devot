// The limits the app's note_put checks (src-tauri/src/commands/notes.rs; a policy test checks they match). The core cuts titles to fit before storage (clipTitle),
// so a long title never stops a note from saving; every storage adapter refuses a record outside the limits with note_put's codes (checkNote).

import { MAX_NOTE_LINKS, noteLinks } from './links'
import type { NoteRecord } from './storage'

export const MAX_TITLE_CHARS = 1000
export const MAX_BODY_BYTES = 32 * 1024 * 1024
export const MAX_YDOC_BYTES = 64 * 1024 * 1024
/** A write is based on a version below it, so the version storage moves it on to is still a whole number JavaScript holds exactly. */
export const MAX_BODY_VERSION = Number.MAX_SAFE_INTEGER

const LINK_CHARS = 'devot://note/'.length + 36

/** A lone surrogate counts as one code point, as it does once it reaches Rust. */
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

export function clipTitle(title: string): string {
  const line = title.replace(/\r\n?|\n/g, ' ')
  return line.slice(0, cutAt(line, MAX_TITLE_CHARS))
}

function overBytes(text: string, max: number): boolean {
  // A UTF-16 unit is at most three bytes in UTF-8: count only when it may not fit.
  if (text.length * 3 <= max) return false
  return new TextEncoder().encode(text).length > max
}

/** Throws the code note_put refuses `note` with. */
export function checkNote(note: NoteRecord, links?: readonly string[]): void {
  const { title, bodyMd, bodyVersion, ydoc } = note
  if (/[\r\n]/.test(title) || cutAt(title, MAX_TITLE_CHARS) < title.length) {
    throw new Error('E_NOTE_TITLE_INVALID')
  }
  if (overBytes(bodyMd, MAX_BODY_BYTES)) throw new Error('E_NOTE_BODY_TOO_LARGE')
  if (!Number.isSafeInteger(bodyVersion) || bodyVersion < 0 || bodyVersion >= MAX_BODY_VERSION) {
    throw new Error('E_NOTE_VERSION_INVALID')
  }
  if (ydoc.length === 0 || ydoc.length > MAX_YDOC_BYTES) throw new Error('E_NOTE_YDOC_INVALID')
  if (bodyMd.length <= MAX_NOTE_LINKS * LINK_CHARS) return
  if ((links ?? noteLinks(bodyMd)).length > MAX_NOTE_LINKS) throw new Error('E_NOTE_LINKS_TOO_MANY')
}
