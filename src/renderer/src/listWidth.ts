// The note list's width, which the user sets by dragging its right edge. It
// is a view preference of the window: it lives in the webview's local
// storage, never in the settings files, and is saved when a drag ends.
import { sizes } from './theme/tokens'

const px = (value: string) => Number.parseFloat(value)

export const LIST_DEFAULT_WIDTH = px(sizes['size.list-default-width'])
export const LIST_MIN_WIDTH = px(sizes['size.list-min-width'])
export const LIST_MAX_WIDTH = px(sizes['size.list-max-width'])

const KEY = 'devot.list.width'

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `width` in whole pixels between the minimum and the maximum (the default for a non-number). */
export function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return LIST_DEFAULT_WIDTH
  return Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.round(width)))
}

/** How far an arrow key moves the edge, and with Shift. */
export const LIST_KEY_STEP = 10
export const LIST_KEY_STEP_LARGE = 50

/**
 * The width a key on the resize edge gives, or undefined for a key that
 * does nothing there: Left and Right step (Shift: larger steps), Home and
 * End go to the narrowest and widest, Enter returns to the default.
 */
export function listWidthForKey(key: string, shift: boolean, width: number): number | undefined {
  const step = shift ? LIST_KEY_STEP_LARGE : LIST_KEY_STEP
  switch (key) {
    case 'ArrowLeft':
      return clampListWidth(width - step)
    case 'ArrowRight':
      return clampListWidth(width + step)
    case 'Home':
      return LIST_MIN_WIDTH
    case 'End':
      return LIST_MAX_WIDTH
    case 'Enter':
      return LIST_DEFAULT_WIDTH
    default:
      return undefined
  }
}

/** The width last set, kept in `storage` (none: nothing is remembered). */
export function listWidthStore(storage: KeyValue | undefined) {
  return {
    read(): number {
      try {
        const stored = storage?.getItem(KEY)
        if (!stored) return LIST_DEFAULT_WIDTH
        return clampListWidth(Number(stored))
      } catch {
        return LIST_DEFAULT_WIDTH
      }
    },
    write(width: number): void {
      try {
        storage?.setItem(KEY, String(clampListWidth(width)))
      } catch {
        // Storage that is full or off forgets the width; the list still works.
      }
    },
  }
}

/** The store in this webview's local storage. */
export function currentListWidthStore() {
  let storage: KeyValue | undefined
  try {
    storage = (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    storage = undefined
  }
  return listWidthStore(storage)
}
