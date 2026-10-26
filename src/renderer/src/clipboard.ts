// The system clipboard. Rust reads and writes it (`clipboard_read_text`,
// `clipboard_write_text`): WebKit lets a page use the clipboard only during
// a gesture in the page (and shows its own Paste button before a read), and
// a native menu click or a command run from the palette is no such gesture.
import { MAX_BODY_BYTES } from '../../core/noteLimits'
import { invoke } from './ipc'

/**
 * The most `clipboard_write_text` takes, in UTF-8 bytes: as much as a note
 * may hold (MAX_CLIPBOARD_TEXT_LEN in src-tauri/src/native/mod.rs).
 */
export const NATIVE_CLIPBOARD_LIMIT = MAX_BODY_BYTES

export function fitsNativeClipboard(text: string): boolean {
  // A UTF-16 code unit is at most three bytes in UTF-8: count only when it may not fit.
  if (text.length * 3 <= NATIVE_CLIPBOARD_LIMIT) return true
  return new TextEncoder().encode(text).length <= NATIVE_CLIPBOARD_LIMIT
}

/**
 * Puts plain text on the clipboard: through Rust, like every copy, or, for
 * text beyond what that command takes, through the page's clipboard API,
 * which a click or a key in the page allows (and nothing else does: then it
 * fails with E_CLIPBOARD_TEXT_TOO_LONG).
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (fitsNativeClipboard(text)) {
    await invoke('clipboard_write_text', { text })
    return
  }
  try {
    // Typed here: the Node types the tests check this file with have no clipboard.
    const page = navigator as unknown as { clipboard: { writeText(text: string): Promise<void> } }
    await page.clipboard.writeText(text)
  } catch {
    throw new Error('E_CLIPBOARD_TEXT_TOO_LONG')
  }
}

/**
 * Puts a secret on this Mac's clipboard only, marked so clipboard managers skip it; Rust clears it
 * after a while unless something else was copied since.
 */
export async function writeClipboardSecret(text: string): Promise<void> {
  await invoke('clipboard_write_secret', { text })
}

export async function readClipboardText(): Promise<string> {
  const text = await invoke<unknown>('clipboard_read_text')
  return typeof text === 'string' ? text : ''
}
