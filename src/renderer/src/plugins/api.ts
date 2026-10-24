// The plugin commands (src-tauri/src/plugins/mod.rs) and the events Rust sends about plugins, which the page re-sends as window
// events (the UI tests send them too).
import {
  parseManifest,
  type InstalledPlugin,
  type PluginManifest,
  type PluginPermission,
} from '../../../core/plugins'
import { invoke } from '../ipc'

export const PLUGINS_CHANGED = 'devot:plugins-changed'
/** A pick in the menu bar: `{ kind, plugin, id }` (src-tauri/src/plugins/menu.rs). */
export const PLUGIN_ACTION = 'devot:plugin-action'
export const PLUGIN_ACTION_TAURI = 'devot://plugin-action'
const PLUGINS_CHANGED_TAURI = 'devot://plugins-changed'

export interface StagedPlugin {
  token: number
  manifest: PluginManifest
  replaces: { version: string; granted: PluginPermission[] } | null
}

/** Read again here: a manifest the page cannot read is left out, as Rust leaves out one it cannot. */
const checked = (plugin: InstalledPlugin): InstalledPlugin | undefined => {
  try {
    return { ...plugin, manifest: parseManifest(plugin.manifest) }
  } catch (error) {
    console.warn('W_PLUGIN_MANIFEST_REFUSED', plugin.manifest?.id, (error as Error).message)
    return undefined
  }
}

export const listPlugins = () =>
  invoke<InstalledPlugin[]>('plugins_list').then((list) =>
    list.flatMap((p) => {
      const ok = checked(p)
      return ok ? [ok] : []
    }),
  )

export const pickPlugin = (kind: 'folder' | 'archive') =>
  invoke<StagedPlugin | null>('plugin_install_pick', { kind })

export const installPlugin = (token: number) =>
  invoke<InstalledPlugin>('plugin_install_confirm', { token })

export const cancelInstall = (token: number) =>
  invoke<null>('plugin_install_cancel', { token }).then(() => undefined)

export const setPluginEnabled = (id: string, enabled: boolean) =>
  invoke<null>('plugin_set_enabled', { id, enabled }).then(() => undefined)

export const removePlugin = (id: string) =>
  invoke<null>('plugin_remove', { id }).then(() => undefined)

export const pickImportFiles = (plugin: string, format: string) =>
  invoke<{ name: string; text: string }[] | null>('plugin_import_pick', { plugin, format })

export const saveExport = (plugin: string, format: string, title: string, text: string) =>
  invoke<boolean>('plugin_export_save', { plugin, format, title, text })

/** Calls `onChange` whenever plugins are installed, removed or turned on or off, in any window. */
export function watchPlugins(onChange: () => void): () => void {
  window.addEventListener(PLUGINS_CHANGED, onChange)
  let stopped = false
  let unlisten: (() => void) | undefined
  if (!DEVOT_UI_TEST) {
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const stop = await listen(PLUGINS_CHANGED_TAURI, () =>
          window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED)),
        )
        if (stopped) stop()
        else unlisten = stop
      })
      .catch(() => console.warn('W_PLUGINS_LISTEN_FAILED'))
  }
  return () => {
    stopped = true
    window.removeEventListener(PLUGINS_CHANGED, onChange)
    unlisten?.()
  }
}
