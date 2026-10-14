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
