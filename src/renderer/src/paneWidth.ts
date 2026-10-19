// The width of a resizable pane (the sidebar, the note list), which the user
// sets by dragging its right edge. It is a view preference of the window: it
// lives in the webview's local storage, never in the settings files, and is
// saved when a drag ends.
import { sizes } from './theme/tokens'

const px = (value: string) => Number.parseFloat(value)

export interface PaneSpec {
  key: string
  min: number
  default: number
  max: number
}

export const LIST_PANE: PaneSpec = {
  key: 'devot.list.width',
  min: px(sizes['size.list-min-width']),
  default: px(sizes['size.list-default-width']),
  max: px(sizes['size.list-max-width']),
}

export const SIDEBAR_PANE: PaneSpec = {
  key: 'devot.sidebar.width',
  min: px(sizes['size.sidebar-min-width']),
  default: px(sizes['size.sidebar-width']),
  max: px(sizes['size.sidebar-max-width']),
}

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PANE_KEY_STEP = 10
export const PANE_KEY_STEP_LARGE = 50

export function clampPaneWidth(pane: PaneSpec, width: number): number {
  if (!Number.isFinite(width)) return pane.default
  return Math.min(pane.max, Math.max(pane.min, Math.round(width)))
}

/**
 * The width a key on the resize edge gives, or undefined for a key that
 * does nothing there: Left and Right step (Shift: larger steps), Home and
 * End go to the narrowest and widest, Enter returns to the default.
 */
export function paneWidthForKey(
  pane: PaneSpec,
  key: string,
  shift: boolean,
  width: number,
): number | undefined {
  const step = shift ? PANE_KEY_STEP_LARGE : PANE_KEY_STEP
  switch (key) {
    case 'ArrowLeft':
      return clampPaneWidth(pane, width - step)
    case 'ArrowRight':
      return clampPaneWidth(pane, width + step)
    case 'Home':
      return pane.min
    case 'End':
      return pane.max
    case 'Enter':
      return pane.default
    default:
      return undefined
  }
}

export function paneWidthStore(pane: PaneSpec, storage: KeyValue | undefined) {
  return {
    read(): number {
      try {
        const stored = storage?.getItem(pane.key)
        if (!stored) return pane.default
        return clampPaneWidth(pane, Number(stored))
      } catch {
        return pane.default
      }
    },
    write(width: number): void {
      try {
        storage?.setItem(pane.key, String(clampPaneWidth(pane, width)))
      } catch {
        // Storage that is full or off forgets the width; the pane still works.
      }
    },
  }
}

export function currentPaneWidthStore(pane: PaneSpec) {
  let storage: KeyValue | undefined
  try {
    storage = (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    storage = undefined
  }
  return paneWidthStore(pane, storage)
}
