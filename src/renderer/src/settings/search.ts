// What Settings' search finds: the panes themselves and the settings named in them
// (searchEntries.ts). The iPhone's native Settings runs a Swift port over the same entries, and
// tests/fixtures/settings-search.json keeps the two in step.
import type { MessageKey } from '../i18n'
import { PANES, PANE_TABS, type PaneId } from './panes'
import { SETTINGS_ENTRIES } from './searchEntries'

export interface SettingsResult {
  pane: PaneId
  /** The pane's own name for a pane result; the setting's name otherwise. */
  label: MessageKey
  /** The pane's name, shown beside a setting. */
  paneLabel?: MessageKey
}

export interface SearchScope {
  /** Search what the iPhone shows instead of what the Mac shows. */
  onPhone?: boolean
  /** The panes to search; all of them when left out. */
  panes?: readonly PaneId[]
  limit?: number
}

/**
 * Panes and settings whose name holds every word of `query`, case- and
 * accent-insensitive, panes first; an empty query finds nothing.
 */
export function searchSettings(
  query: string,
  label: (key: MessageKey) => string,
  scope: SearchScope = {},
): SettingsResult[] {
  const words = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  if (words.length === 0) return []
  const matches = (text: string) => {
    const folded = text.toLocaleLowerCase()
    return words.every((word) => folded.includes(word))
  }
  const panes = scope.panes ?? PANES
  const device = scope.onPhone ? 'phone' : 'mac'
  const found: SettingsResult[] = []
  for (const pane of PANES) {
    const name = PANE_TABS[pane].label
    if (panes.includes(pane) && matches(label(name))) found.push({ pane, label: name })
  }
  for (const entry of SETTINGS_ENTRIES) {
    if (!panes.includes(entry.pane) || (entry.only ?? device) !== device) continue
    if (!matches(label(entry.label))) continue
    found.push({ pane: entry.pane, label: entry.label, paneLabel: PANE_TABS[entry.pane].label })
  }
  return found.slice(0, scope.limit ?? 12)
}
