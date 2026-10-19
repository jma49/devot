import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MAX_BODY_BYTES } from '../../src/core/noteLimits'
import { NATIVE_CLIPBOARD_LIMIT, fitsNativeClipboard } from '../../src/renderer/src/clipboard'

// The UI sends text to `clipboard_write_text` only when Rust takes it (longer text uses the page's clipboard
// API), so both sides must agree on the limit: as much as a note may hold, as a paste takes.
const NATIVE = readFileSync('src-tauri/src/native/mod.rs', 'utf8')

it('uses the limit Rust checks: what a note may hold', () => {
  const stated = /const MAX_CLIPBOARD_TEXT_LEN: usize = ([^;]+);/.exec(NATIVE)?.[1]
  expect(stated).toBe('crate::commands::notes::MAX_BODY_BYTES')
  expect(NATIVE_CLIPBOARD_LIMIT).toBe(MAX_BODY_BYTES)
})

it('counts UTF-8 bytes, as Rust does', () => {
  expect(fitsNativeClipboard('x'.repeat(NATIVE_CLIPBOARD_LIMIT))).toBe(true)
  expect(fitsNativeClipboard('x'.repeat(NATIVE_CLIPBOARD_LIMIT + 1))).toBe(false)
  // Three bytes each (U+2026, the ellipsis).
  const third = Math.floor(NATIVE_CLIPBOARD_LIMIT / 3)
  expect(fitsNativeClipboard('…'.repeat(third))).toBe(true)
  expect(fitsNativeClipboard('…'.repeat(third + 1))).toBe(false)
})
