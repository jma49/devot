// The Settings window's panes, in navigation order, and the one it showed last.
// Which pane was open is a view preference of the window: it lives in the
// webview's local storage, never in the settings files, and a value that
// does not name a pane falls back to the first.
import type { IconName } from '../icons/symbols'
import type { MessageKey } from '../i18n'

export const PANES = [
  'general',
  'appearance',
  'editing',
  'preview',
  'keyboard',
  'mirror',
  'sync',
  'ai',
  'integrations',
  'plugins',
  'usage',
  'licence',
] as const
export type PaneId = (typeof PANES)[number]

export const PANE_TABS: Readonly<Record<PaneId, { label: MessageKey; icon: IconName }>> = {
  general: { label: 'settings.pane.general', icon: 'settings.general' },
  editing: { label: 'settings.pane.editing', icon: 'settings.editing' },
  preview: { label: 'settings.pane.preview', icon: 'settings.preview' },
  appearance: { label: 'settings.pane.appearance', icon: 'settings.appearance' },
  keyboard: { label: 'settings.pane.keyboard', icon: 'settings.keyboard' },
  mirror: { label: 'settings.pane.mirror', icon: 'settings.mirror' },
  sync: { label: 'settings.pane.sync', icon: 'settings.sync' },
  ai: { label: 'settings.pane.ai', icon: 'settings.ai' },
  licence: { label: 'settings.pane.licence', icon: 'settings.licence' },
  integrations: { label: 'settings.pane.integrations', icon: 'settings.integrations' },
  plugins: { label: 'settings.pane.plugins', icon: 'settings.plugins' },
  usage: { label: 'settings.pane.usage', icon: 'settings.usage' },
}

/** The coloured tile before each row's name: its glyph, its ground, and a glyph that needs a dark one. */
export const PANE_TILES: Readonly<
  Record<PaneId, { icon: IconName; color: string; foreground?: string }>
> = {
  general: { icon: 'settings.tile.general', color: 'var(--color-icon-tile-general)' },
  appearance: { icon: 'settings.tile.appearance', color: 'var(--color-icon-tile-appearance)' },
  editing: { icon: 'settings.tile.editing', color: 'var(--color-icon-tile-editing)' },
  preview: { icon: 'settings.tile.preview', color: 'var(--color-icon-tile-preview)' },
  keyboard: { icon: 'settings.tile.keyboard', color: 'var(--color-icon-tile-keyboard)' },
  mirror: { icon: 'settings.tile.mirror', color: 'var(--color-icon-tile-mirror)' },
  sync: { icon: 'settings.tile.sync', color: 'var(--color-icon-tile-sync)' },
  ai: { icon: 'settings.tile.ai', color: 'var(--color-icon-tile-ai)' },
  integrations: {
    icon: 'settings.tile.integrations',
    color: 'var(--color-icon-tile-integrations)',
  },
  plugins: { icon: 'settings.tile.plugins', color: 'var(--color-icon-tile-plugins)' },
  usage: {
    icon: 'settings.tile.usage',
    color: 'var(--color-icon-tile-usage)',
    foreground: 'var(--color-icon-tile-foreground-contrast)',
  },
  licence: { icon: 'settings.tile.license', color: 'var(--color-icon-tile-license)' },
}

const KEY = 'devot.settings.pane'

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const isPane = (value: unknown): value is PaneId =>
  typeof value === 'string' && (PANES as readonly string[]).includes(value)

/** A pane that was renamed, by the name it was remembered under. */
const RENAMED: Readonly<Record<string, PaneId>> = { editor: 'editing' }

export function paneStore(storage: KeyValue | undefined) {
  return {
    read(): PaneId {
      try {
        const stored = storage?.getItem(KEY)
        if (typeof stored === 'string' && Object.hasOwn(RENAMED, stored)) return RENAMED[stored]!
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

/** The pane `settings.html?pane=<pane>` asks for: Rust opens Settings so for Add Licence. */
export function paneFromQuery(search: string): PaneId | undefined {
  const pane = new URLSearchParams(search).get('pane')
  return isPane(pane) ? pane : undefined
}

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
 * The pane a key moves to from `pane` in the navigation column: the Up and
 * Down arrow keys step (and wrap), Home and End go to the ends; undefined for
 * any other key.
 */
export function paneAfterKey(pane: PaneId, key: string): PaneId | undefined {
  const at = PANES.indexOf(pane)
  const last = PANES.length - 1
  switch (key) {
    case 'ArrowDown':
      return PANES[at === last ? 0 : at + 1]
    case 'ArrowUp':
      return PANES[at === 0 ? last : at - 1]
    case 'Home':
      return PANES[0]
    case 'End':
      return PANES[last]
    default:
      return undefined
  }
}
