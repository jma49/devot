// The width of a resizable pane (the sidebar, the note list, the board), which the user
// sets by dragging its right edge. It is a view preference of the window: it
// lives in the webview's local storage, never in the settings files, and is
// saved when a drag ends.
import { NOTE_STATUSES } from '../../core/storage'
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

/** `.board-columns` in app.css: the columns at their width, `space.5` apart, the outer keyline at each side. */
const boardColumnsWidth = (columns: number) =>
  2 * px(sizes['size.list-keyline-outer']) +
  columns * px(sizes['size.board-column-width']) +
  Math.max(0, columns - 1) * px(sizes['space.5'])

/** The note list while it shows a board or a gallery: wider, with a width of its own. */
export const BOARD_PANE: PaneSpec = {
  key: 'devot.board.width',
  min: px(sizes['size.board-min-width']),
  default: boardColumnsWidth(NOTE_STATUSES.length),
  max: px(sizes['size.board-max-width']),
}

/** The board's width (and the gallery's) until the user sets one: exactly as wide as `columns` board columns. */
export function fittedBoardWidth(columns: number): number {
  return clampPaneWidth(BOARD_PANE, boardColumnsWidth(columns))
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
  removeItem(key: string): void
}

const PANE_KEY_STEP = 10
const PANE_KEY_STEP_LARGE = 50

export function clampPaneWidth(pane: PaneSpec, width: number): number {
  if (!Number.isFinite(width)) return pane.default
  return Math.min(pane.max, Math.max(pane.min, Math.round(width)))
}

/** The width a pane shows: the one the user set, else `fitted` (the board's), else its default. */
export function shownPaneWidth(
  pane: PaneSpec,
  stored: number | undefined,
  fitted: number | undefined,
): number {
  return clampPaneWidth(pane, stored ?? fitted ?? pane.default)
}

/**
 * The width a key on the resize edge gives, or undefined for a key that
 * does nothing there: Left and Right step (Shift: larger steps), Home and
 * End go to the narrowest and widest, and Enter forgets the width set
 * (`reset`), so the pane takes its default or fitted width again.
 */
export function paneWidthForKey(
  pane: PaneSpec,
  key: string,
  shift: boolean,
  width: number,
): number | 'reset' | undefined {
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
      return 'reset'
    default:
      return undefined
  }
}

export function paneWidthStore(pane: PaneSpec, storage: KeyValue | undefined) {
  const stored = (): number | undefined => {
    try {
      const value = Number(storage?.getItem(pane.key) || Number.NaN)
      return Number.isFinite(value) ? clampPaneWidth(pane, value) : undefined
    } catch {
      return undefined
    }
  }
  return {
    /** The width the user set, if any. */
    stored,
    read: (): number => stored() ?? pane.default,
    write(width: number): void {
      try {
        storage?.setItem(pane.key, String(clampPaneWidth(pane, width)))
      } catch {
        // Storage that is full or off forgets the width; the pane still works.
      }
    },
    clear(): void {
      try {
        storage?.removeItem(pane.key)
      } catch {
        // Storage that is off keeps nothing to forget.
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
