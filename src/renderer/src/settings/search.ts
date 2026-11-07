// What Settings' search finds: the panes themselves and the settings named in
// them. The list is static so a search never has to render a pane; a setting
// that is added to a pane without an entry here is still found by its pane.
// An entry marked for one device names a row that only that device shows.
import type { MessageKey } from '../i18n'
import { PANES, PANE_TABS, type PaneId } from './panes'

interface SettingsEntry {
  pane: PaneId
  label: MessageKey
  only?: 'mac' | 'phone'
}

const ENTRIES: readonly SettingsEntry[] = [
  { pane: 'general', label: 'generalSettings.defaultNotebook', only: 'mac' },
  { pane: 'general', label: 'generalSettings.dailyNotes', only: 'mac' },
  { pane: 'general', label: 'generalSettings.listDates', only: 'mac' },
  { pane: 'general', label: 'generalSettings.boardDropped', only: 'mac' },
  { pane: 'general', label: 'generalSettings.activityStrip', only: 'mac' },
  { pane: 'general', label: 'generalSettings.dataFolder', only: 'mac' },
  { pane: 'general', label: 'generalSettings.backups', only: 'mac' },
  { pane: 'general', label: 'generalSettings.commandLineTool', only: 'mac' },
  { pane: 'general', label: 'generalSettings.keepInMenuBar', only: 'mac' },
  { pane: 'general', label: 'generalSettings.updates', only: 'mac' },
  { pane: 'general', label: 'generalSettings.crashReports' },
  { pane: 'appearance', label: 'appearanceSettings.colorScheme' },
  { pane: 'appearance', label: 'appearanceSettings.glassAmount', only: 'mac' },
  { pane: 'appearance', label: 'phone.appearance.transparency', only: 'phone' },
  { pane: 'appearance', label: 'appearanceSettings.systemAccent', only: 'mac' },
  { pane: 'appearance', label: 'appearanceSettings.lightMode' },
  { pane: 'appearance', label: 'appearanceSettings.darkMode' },
  { pane: 'appearance', label: 'appearanceSettings.iconStyle', only: 'mac' },
  { pane: 'appearance', label: 'phone.appearance.textSize', only: 'phone' },
  { pane: 'appearance', label: 'editorSettings.noteFont' },
  { pane: 'appearance', label: 'appearanceSettings.previewFontSize' },
  { pane: 'appearance', label: 'appearanceSettings.animations' },
  { pane: 'editing', label: 'editorSettings.toolbar' },
  { pane: 'editing', label: 'editorSettings.lineNumbers' },
  { pane: 'editing', label: 'editorSettings.highlightActiveLine' },
  { pane: 'editing', label: 'editorSettings.lineWrapping' },
  { pane: 'editing', label: 'editorSettings.inlineImages' },
  { pane: 'editing', label: 'editorSettings.readableWidth' },
  { pane: 'editing', label: 'editorSettings.scrollPastEnd' },
  { pane: 'editing', label: 'editorSettings.showCounts', only: 'mac' },
  { pane: 'editing', label: 'editorSettings.cursorScrollMargin' },
  { pane: 'editing', label: 'editorSettings.listMarker' },
  { pane: 'editing', label: 'editorSettings.indentUnit' },
  { pane: 'editing', label: 'editorSettings.tabWidth' },
  { pane: 'editing', label: 'editorSettings.pasteUrl' },
  { pane: 'editing', label: 'editorSettings.spellCheck' },
  { pane: 'editing', label: 'editorSettings.fontSize', only: 'mac' },
  { pane: 'editing', label: 'editorSettings.fontWeight' },
  { pane: 'editing', label: 'editorSettings.lineHeight' },
  { pane: 'editing', label: 'editorSettings.showInvisibles' },
  { pane: 'editing', label: 'editorSettings.highlightTrailingWhitespace' },
  { pane: 'preview', label: 'previewSettings.syncScroll', only: 'mac' },
  { pane: 'preview', label: 'previewSettings.remoteImages' },
  { pane: 'mirror', label: 'mirror.folderLabel' },
  { pane: 'mirror', label: 'mirror.includeAttachments' },
  { pane: 'sync', label: 'syncSettings.relay' },
  { pane: 'sync', label: 'syncSettings.secret' },
  { pane: 'sync', label: 'syncSettings.setup' },
  { pane: 'sync', label: 'syncSettings.usage.title' },
  { pane: 'sync', label: 'syncSettings.enabled' },
  { pane: 'sync', label: 'syncSettings.status' },
  { pane: 'ai', label: 'aiSettings.active', only: 'mac' },
  { pane: 'ai', label: 'phone.ai.provider', only: 'phone' },
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
  for (const entry of ENTRIES) {
    if (!panes.includes(entry.pane) || (entry.only ?? device) !== device) continue
    if (!matches(label(entry.label))) continue
    found.push({ pane: entry.pane, label: entry.label, paneLabel: PANE_TABS[entry.pane].label })
  }
  return found.slice(0, scope.limit ?? 12)
}
