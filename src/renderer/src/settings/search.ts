// What Settings' search finds: the panes themselves and the settings named in
// them. The list is static so a search never has to render a pane; a setting
// that is added to a pane without an entry here is still found by its pane.
import type { MessageKey } from '../i18n'
import { PANES, PANE_TABS, type PaneId } from './panes'

interface SettingsEntry {
  pane: PaneId
  label: MessageKey
}

const ENTRIES: readonly SettingsEntry[] = [
  { pane: 'general', label: 'generalSettings.defaultNotebook' },
  { pane: 'general', label: 'generalSettings.listDates' },
  { pane: 'general', label: 'generalSettings.boardDropped' },
  { pane: 'general', label: 'generalSettings.activityStrip' },
  { pane: 'general', label: 'generalSettings.dataFolder' },
  { pane: 'general', label: 'generalSettings.backups' },
  { pane: 'general', label: 'generalSettings.commandLineTool' },
  { pane: 'general', label: 'generalSettings.keepInMenuBar' },
  { pane: 'general', label: 'generalSettings.updates' },
  { pane: 'appearance', label: 'appearanceSettings.colorScheme' },
  { pane: 'appearance', label: 'appearanceSettings.interfaceStyle' },
  { pane: 'appearance', label: 'appearanceSettings.glassAmount' },
  { pane: 'appearance', label: 'appearanceSettings.systemAccent' },
  { pane: 'appearance', label: 'appearanceSettings.lightMode' },
  { pane: 'appearance', label: 'appearanceSettings.darkMode' },
  { pane: 'appearance', label: 'appearanceSettings.iconStyle' },
  { pane: 'appearance', label: 'appearanceSettings.animations' },
  { pane: 'editing', label: 'editorSettings.lineWrapping' },
  { pane: 'editing', label: 'editorSettings.cursorScrollMargin' },
  { pane: 'editing', label: 'editorSettings.listMarker' },
  { pane: 'editing', label: 'editorSettings.indentUnit' },
  { pane: 'editing', label: 'editorSettings.tabWidth' },
  { pane: 'editing', label: 'editorSettings.pasteUrl' },
  { pane: 'editing', label: 'editorSettings.fontSize' },
  { pane: 'editing', label: 'editorSettings.fontWeight' },
  { pane: 'editing', label: 'editorSettings.lineHeight' },
  { pane: 'preview', label: 'previewSettings.fontSize' },
  { pane: 'preview', label: 'previewSettings.syncScroll' },
  { pane: 'mirror', label: 'mirror.folderLabel' },
  { pane: 'mirror', label: 'mirror.includeAttachments' },
  { pane: 'sync', label: 'syncSettings.relay' },
  { pane: 'sync', label: 'syncSettings.secret' },
  { pane: 'sync', label: 'syncSettings.newVault' },
  { pane: 'sync', label: 'syncSettings.enabled' },
  { pane: 'sync', label: 'syncSettings.status' },
  { pane: 'ai', label: 'aiSettings.active' },
  { pane: 'ai', label: 'aiSettings.suggestOnIdle' },
  { pane: 'ai', label: 'aiSettings.endpoint' },
  { pane: 'ai', label: 'aiSettings.model' },
  { pane: 'ai', label: 'aiSettings.key' },
  { pane: 'licence', label: 'licenceSettings.status' },
  { pane: 'licence', label: 'licenceSettings.trial' },
  { pane: 'licence', label: 'licenceSettings.key' },
  { pane: 'integrations', label: 'httpApi.title' },
  { pane: 'integrations', label: 'httpApi.enabled' },
  { pane: 'integrations', label: 'httpApi.port' },
  { pane: 'integrations', label: 'httpApi.token' },
  { pane: 'plugins', label: 'plugins.permissions' },
  { pane: 'plugins', label: 'plugins.reviewAsks' },
]

export interface SettingsResult {
  pane: PaneId
  /** The pane's own name for a pane result; the setting's name otherwise. */
  label: MessageKey
  /** The pane's name, shown beside a setting. */
  paneLabel?: MessageKey
}

/**
 * Panes and settings whose name holds every word of `query`, case- and
 * accent-insensitive, panes first; an empty query finds nothing.
 */
export function searchSettings(
  query: string,
  label: (key: MessageKey) => string,
  limit = 12,
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
  const found: SettingsResult[] = []
  for (const pane of PANES) {
    const name = PANE_TABS[pane].label
    if (matches(label(name))) found.push({ pane, label: name })
  }
  for (const entry of ENTRIES) {
    if (!matches(label(entry.label))) continue
    found.push({ pane: entry.pane, label: entry.label, paneLabel: PANE_TABS[entry.pane].label })
  }
  return found.slice(0, limit)
}
