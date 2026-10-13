// The Settings window's panes, in toolbar order, and the one it showed last.
// Which pane was open is a view preference of the window: it lives in the
// webview's local storage, never in the settings files, and a value that
// does not name a pane falls back to the first.
import type { IconName } from '../icons/symbols'
import type { MessageKey } from '../i18n'

export const PANES = ['general', 'editor', 'appearance', 'keyboard', 'mirror', 'usage'] as const
export type PaneId = (typeof PANES)[number]

/** Each pane's toolbar label and symbol. */
export const PANE_TABS: Readonly<Record<PaneId, { label: MessageKey; icon: IconName }>> = {
  general: { label: 'settings.pane.general', icon: 'settings.general' },
  editor: { label: 'settings.pane.editor', icon: 'settings.editor' },
  appearance: { label: 'settings.pane.appearance', icon: 'settings.appearance' },
  keyboard: { label: 'settings.pane.keyboard', icon: 'settings.keyboard' },
  mirror: { label: 'settings.pane.mirror', icon: 'settings.mirror' },
  usage: { label: 'settings.pane.usage', icon: 'settings.usage' },
}

const KEY = 'devot.settings.pane'

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const isPane = (value: unknown): value is PaneId =>
  typeof value === 'string' && (PANES as readonly string[]).includes(value)

/** The pane last shown, kept in `storage` (none: nothing is remembered). */
export function paneStore(storage: KeyValue | undefined) {
  return {
    read(): PaneId {
      try {
        const stored = storage?.getItem(KEY)
        return isPane(stored) ? stored : PANES[0]
      } catch {
        return PANES[0]
      }
    },
    write(pane: PaneId): void {
      try {
        storage?.setItem(KEY, pane)
      } catch {
        // Storage that is full or off forgets the pane; the window still works.
      }
    },
  }
}

/** The store in this webview's local storage. */
export function currentPaneStore() {
  let storage: KeyValue | undefined
  try {
    storage = (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    storage = undefined
  }
  return paneStore(storage)
}

/**
 * The pane a key moves to from `pane` in the toolbar: the arrow keys step
 * (and wrap), Home and End go to the ends; undefined for any other key.
 */
export function paneAfterKey(pane: PaneId, key: string): PaneId | undefined {
  const at = PANES.indexOf(pane)
  const last = PANES.length - 1
  switch (key) {
    case 'ArrowRight':
      return PANES[at === last ? 0 : at + 1]
    case 'ArrowLeft':
      return PANES[at === 0 ? last : at - 1]
    case 'Home':
      return PANES[0]
    case 'End':
      return PANES[last]
    default:
      return undefined
  }
}
