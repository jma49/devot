// What enabled plugins contribute to the window (ADR 0005), each only with the permission the user granted: palette entries for
// their commands and formats, their keys, their preview renderers. The menu bar's items are Rust's (src-tauri/src/plugins/menu.rs).
import { errorCode } from '../../../core/errors'
import { effectivePermissions, type InstalledPlugin } from '../../../core/plugins'
import type { PluginRendererSpec } from '../../../core/preview'
import { isShortcut, normalizeShortcut, parseShortcut } from '../commands/keys'

export type ActionKind = 'command' | 'import' | 'export'

export interface PluginAction {
  kind: ActionKind
  plugin: string
  id: string
}

export interface PluginItem extends PluginAction {
  title: string
  pluginName: string
}

const enabled = (plugins: readonly InstalledPlugin[]) =>
  plugins
    .filter((p) => p.enabled)
    .map((p) => ({ plugin: p, granted: effectivePermissions(p) }))
    .sort((a, b) => (a.plugin.manifest.id < b.plugin.manifest.id ? -1 : 1))

const PREFIX = 'plugin:'

/** A palette entry's ID for a plugin's command or format, never one of the registry's. */
export const actionEntryId = (a: PluginAction) => `${PREFIX}${a.kind}:${a.plugin}/${a.id}`

export function actionOfEntry(entryId: string): PluginAction | undefined {
  const match = /^plugin:(command|import|export):([^/]+)\/(.+)$/.exec(entryId)
  if (!match) return undefined
  return { kind: match[1] as ActionKind, plugin: match[2]!, id: match[3]! }
}

/** Commands (with `commands`), then import and export formats, plugin by plugin. */
export function pluginItems(plugins: readonly InstalledPlugin[]): PluginItem[] {
  const out: PluginItem[] = []
  for (const { plugin, granted } of enabled(plugins)) {
    const m = plugin.manifest
    const base = { plugin: m.id, pluginName: m.name }
    if (granted.has('commands')) {
      for (const c of m.contributes.commands)
        out.push({ ...base, kind: 'command', id: c.id, title: c.title })
    }
    if (granted.has('import')) {
      for (const f of m.contributes.importFormats)
        out.push({ ...base, kind: 'import', id: f.id, title: f.title })
    }
    if (granted.has('export')) {
      for (const f of m.contributes.exportFormats)
        out.push({ ...base, kind: 'export', id: f.id, title: f.title })
    }
  }
  return out
}

/** Whether a failed import file means the plugin hangs or is gone, so the files after it would each fail the same slow way. */
export const stopsImport = (error: unknown) =>
  ['E_PLUGIN_TIMEOUT', 'E_PLUGIN_STOPPED'].includes(errorCode(error, ''))

export interface PluginKey {
  key: string
  plugin: string
  command: string
}

export interface DroppedKey {
  plugin: string
  command: string
}

/**
 * The keys plugins' commands get: a valid shortcut with Command or Control that `taken` says no app command or reserved key
 * uses, and that no plugin before it (by ID) took. The rest are dropped, for the caller to log.
 */
export function pluginKeys(
  plugins: readonly InstalledPlugin[],
  taken: (key: string) => boolean,
): { keys: PluginKey[]; dropped: DroppedKey[] } {
  const keys: PluginKey[] = []
  const dropped: DroppedKey[] = []
  for (const { plugin, granted } of enabled(plugins)) {
    if (!granted.has('keymaps') || !granted.has('commands')) continue
    for (const { command, key } of plugin.manifest.contributes.keymaps) {
      const usable =
        isShortcut(key) &&
        normalizeShortcut(key) === key &&
        (parseShortcut(key).mod || parseShortcut(key).ctrl) &&
        !taken(key) &&
        !keys.some((k) => k.key === key)
      if (usable) keys.push({ key, plugin: plugin.manifest.id, command })
      else dropped.push({ plugin: plugin.manifest.id, command })
    }
  }
  return { keys, dropped }
}

/** One renderer per language: the first plugin (by ID) that draws it. */
export function rendererSpecs(plugins: readonly InstalledPlugin[]): PluginRendererSpec[] {
  const out: PluginRendererSpec[] = []
  for (const { plugin, granted } of enabled(plugins)) {
    if (!granted.has('preview')) continue
    for (const r of plugin.manifest.contributes.previewRenderers) {
      if (out.some((s) => s.language === r.language)) continue
      out.push({ key: `${plugin.manifest.id}/${r.id}`, language: r.language })
    }
  }
  return out
}

export function rendererOfKey(key: string): { plugin: string; renderer: string } | undefined {
  const at = key.lastIndexOf('/')
  return at > 0 ? { plugin: key.slice(0, at), renderer: key.slice(at + 1) } : undefined
}
