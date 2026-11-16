// The plugin commands (src-tauri/src/plugins/mod.rs) and the events Rust sends about plugins, which the page re-sends as window
// events (the UI tests send them too).
import {
  parseManifest,
  type JsonValue,
  type SettingValue,
  type InstalledPlugin,
  type PluginManifest,
  type PluginPermission,
} from '../../../core/plugins'
import { invoke } from '../ipc'
import { unlistenLater } from '../windowEvents'

const PLUGINS_CHANGED = 'devot:plugins-changed'
/** A pick in the menu bar: `{ kind, plugin, id }` (src-tauri/src/plugins/menu.rs). */
export const PLUGIN_ACTION = 'devot:plugin-action'
export const PLUGIN_ACTION_TAURI = 'devot://plugin-action'
const PLUGINS_CHANGED_TAURI = 'devot://plugins-changed'
const SETTINGS_CHANGED = 'devot:plugin-settings-changed'
const SETTINGS_CHANGED_TAURI = 'devot://plugin-settings-changed'

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

/** A plugin in the official index (src-tauri/src/plugins/catalog.rs), with what it offers this build. */
export interface OfferedPlugin {
  id: string
  name: string
  version: string
  description: string
  author: string
  permissions: PluginPermission[]
  installed: string | null
  offer: 'install' | 'update' | 'installed' | 'needsNewerApp'
}

export const listOfficialPlugins = () => invoke<OfferedPlugin[]>('plugin_catalog')

export const fetchOfficialPlugin = (id: string) =>
  invoke<StagedPlugin>('plugin_catalog_stage', { id })

export const openPluginOffer = (id: string) =>
  invoke<null>('plugin_offer_open', { id }).then(() => undefined)

export const takePluginOffer = () => invoke<string | null>('plugin_offer_take')

const OFFER = 'devot:plugin-offer'
const OFFER_TAURI = 'devot://plugin-offer'

/** Calls `onOffer` when a `devot://plugin/<id>` link asks Settings to show a plugin's review. */
export function watchPluginOffers(onOffer: () => void): () => void {
  window.addEventListener(OFFER, onOffer)
  const unlisten = DEVOT_UI_TEST
    ? undefined
    : unlistenLater(
        import('@tauri-apps/api/event').then(({ listen }) =>
          listen(OFFER_TAURI, () => window.dispatchEvent(new CustomEvent(OFFER))),
        ),
        () => console.warn('W_PLUGIN_OFFER_LISTEN_FAILED'),
      )
  return () => {
    window.removeEventListener(OFFER, onOffer)
    unlisten?.()
  }
}

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

export const pluginStorage = {
  get: (plugin: string, key: string) =>
    invoke<JsonValue | null>('plugin_storage_get', { plugin, key }),
  set: (plugin: string, key: string, value: JsonValue) =>
    invoke<null>('plugin_storage_set', { plugin, key, value }).then(() => undefined),
  delete: (plugin: string, key: string) =>
    invoke<null>('plugin_storage_delete', { plugin, key }).then(() => undefined),
  keys: (plugin: string) => invoke<string[]>('plugin_storage_keys', { plugin }),
}

export const pluginSettings = (plugin: string) =>
  invoke<Record<string, SettingValue>>('plugin_settings_get', { plugin })

export const setPluginSetting = (plugin: string, setting: string, value: SettingValue) =>
  invoke<null>('plugin_settings_set', { plugin, setting, value }).then(() => undefined)

/** Calls `onChange` with the plugin whose settings changed in Settings. */
export function watchPluginSettings(onChange: (plugin: string) => void): () => void {
  const listener = (event: Event) => {
    const plugin = (event as CustomEvent<unknown>).detail
    if (typeof plugin === 'string') onChange(plugin)
  }
  window.addEventListener(SETTINGS_CHANGED, listener)
  const unlisten = DEVOT_UI_TEST
    ? undefined
    : unlistenLater(
        import('@tauri-apps/api/event').then(({ listen }) =>
          listen<string>(SETTINGS_CHANGED_TAURI, (event) =>
            window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED, { detail: event.payload })),
          ),
        ),
        () => console.warn('W_PLUGIN_SETTINGS_LISTEN_FAILED'),
      )
  return () => {
    window.removeEventListener(SETTINGS_CHANGED, listener)
    unlisten?.()
  }
}

/** Calls `onChange` whenever plugins are installed, removed or turned on or off, in any window. */
export function watchPlugins(onChange: () => void): () => void {
  window.addEventListener(PLUGINS_CHANGED, onChange)
  const unlisten = DEVOT_UI_TEST
    ? undefined
    : unlistenLater(
        import('@tauri-apps/api/event').then(({ listen }) =>
          listen(PLUGINS_CHANGED_TAURI, () =>
            window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED)),
          ),
        ),
        () => console.warn('W_PLUGINS_LISTEN_FAILED'),
      )
  return () => {
    window.removeEventListener(PLUGINS_CHANGED, onChange)
    unlisten?.()
  }
}
