// Plugins in the main window (ADR 0005): their frames, the host that speaks to them, and what they contribute: palette entries,
// keys, preview renderers, menu bar picks (`devot://plugin-action`), import and export formats, and the sheet a plugin's UI shows in.
import * as Comlink from 'comlink'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InstalledPlugin } from '../../../core/plugins'
import type { PluginRendererSpec } from '../../../core/preview'
import { errorCode } from '../../../core/errors'
import { sheetOpen, useMenuEvent } from '../commands/dispatch'
import { keyMatches } from '../commands/keys'
import { COMMANDS, commandKeys, RESERVED_KEYS } from '../commands/registry'
import type { Core } from '../core-client'
import { format, t } from '../i18n'
import { isImeKey } from '../ime'
import type { PaletteEntry } from '../palette/results'
import {
  listPlugins,
  pickImportFiles,
  PLUGIN_ACTION,
  PLUGIN_ACTION_TAURI,
  saveExport,
  watchPlugins,
} from './api'
import {
  actionEntryId,
  pluginItems,
  pluginKeys,
  rendererOfKey,
  rendererSpecs,
  type PluginAction,
} from './contributions'
import { frameConnector, showFrame } from './frames'
import { createPluginHost, type PluginHost } from './host'
import { pluginRenderersChanged } from './rendererRevision'

export interface PluginWindow {
  /** The note open in the editor. */
  openNote(): { id: string } | undefined
  /** Applies a Yjs update the core returned to the editor, as one undo step, if it still shows the note. */
  applyUpdate(noteId: string, update: Uint8Array): void
  /** Where imported notes go: the notebook shown, or none. */
  importBook(): string | null
  /** The lists show what an import made. */
  imported(): void
}

const takenByApp = (key: string) =>
  RESERVED_KEYS.includes(key) || COMMANDS.some((c) => commandKeys(c.id).includes(key))

const isAction = (value: unknown): value is PluginAction => {
  const v = value as Partial<PluginAction> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.kind === 'command' || v.kind === 'import' || v.kind === 'export') &&
    typeof v.plugin === 'string' &&
    typeof v.id === 'string'
  )
}

export function usePlugins(core: Core | undefined, app: PluginWindow) {
  const [plugins, setPlugins] = useState<readonly InstalledPlugin[]>([])
  const [panel, setPanel] = useState<{ plugin: string; height: number } | null>(null)
  const [failure, setFailure] = useState<{ name: string; code: string }>()
  const frames = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const latest = useRef({ core, app, plugins })
  useEffect(() => {
    latest.current = { core, app, plugins }
  })

  const [host, setHost] = useState<PluginHost>()
  useEffect(() => {
    const made = createPluginHost({
      connect: frameConnector(frames),
      readNote: async () => {
        const { core: c, app: w } = latest.current
        const open = w.openNote()
        if (!c || !open) return null
        const note = await c.read(open.id)
        return { title: note.title, markdown: note.bodyMd }
      },
      replaceNote: async (edit) => {
        const { core: c, app: w } = latest.current
        const open = w.openNote()
        if (!c || !open) throw new Error('E_PLUGIN_NO_NOTE')
        w.applyUpdate(open.id, await c.applyPluginEdit(open.id, edit))
      },
      showUi: (plugin, height) => setPanel({ plugin, height }),
      hideUi: (plugin) => setPanel((now) => (now?.plugin === plugin ? null : now)),
      warn: (code, plugin) => console.warn('W_PLUGIN_FAILED', code, plugin),
    })
    setHost(made)
    return () => made.stop()
  }, [])

  useEffect(() => {
    let live = true
    const load = () =>
      listPlugins().then(
        (list) => {
          if (live) setPlugins(list)
        },
        (e: unknown) => console.warn('W_PLUGINS_LIST_FAILED', errorCode(e)),
      )
    void load()
    const stop = watchPlugins(() => void load())
    return () => {
      live = false
      stop()
    }
  }, [])

  useEffect(() => host?.load(plugins), [host, plugins])

  const nameOf = useCallback(
    (id: string) => plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id,
    [plugins],
  )
  const fail = useCallback(
    (plugin: string, error: unknown) =>
      setFailure({ name: nameOf(plugin), code: errorCode(error, 'E_PLUGIN_FAILED') }),
    [nameOf],
  )

  // The worker renders the preview again only when the renderers change: never for a list that stays without any.
  const specsKey = JSON.stringify(rendererSpecs(plugins))
  const applied = useRef<{ core: Core; host: PluginHost; key: string }>(undefined)
  useEffect(() => {
    if (!core || !host) return
    const was = applied.current
    applied.current = { core, host, key: specsKey }
    if (specsKey === '[]' && (was === undefined || was.key === '[]')) return
    if (was?.core === core && was.host === host && was.key === specsKey) return
    const render = (key: string, source: string) => {
      const target = rendererOfKey(key)
      return target ? host.render(target.plugin, target.renderer, source) : Promise.resolve(null)
    }
    const specs = JSON.parse(specsKey) as PluginRendererSpec[]
    void core
      .setPluginRenderers(specs, Comlink.proxy(render))
      .then(pluginRenderersChanged, () => console.warn('W_PLUGIN_RENDERERS_FAILED'))
  }, [core, host, specsKey])

  const keys = useMemo(() => {
    const { keys: given, dropped } = pluginKeys(plugins, takenByApp)
    for (const d of dropped) console.warn('W_PLUGIN_KEY_TAKEN', d.plugin, d.command)
    return given
  }, [plugins])

  const act = useCallback(
    async (action: PluginAction) => {
      const { core: c, app: w } = latest.current
      if (!host) return
      try {
        if (action.kind === 'command') {
          await host.run(action.plugin, action.id)
        } else if (action.kind === 'import') {
          if (!c) return
          const files = await pickImportFiles(action.plugin, action.id)
          if (!files) return
          for (const file of files) {
            const note = await host.convertImport(action.plugin, action.id, file)
            await c.capture(note.title, note.markdown, w.importBook())
          }
          w.imported()
        } else {
          const open = w.openNote()
          if (!c || !open) return
          const note = await c.read(open.id)
          const text = await host.convertExport(action.plugin, action.id, {
            title: note.title,
            markdown: note.bodyMd,
          })
          await saveExport(action.plugin, action.id, note.title, text)
        }
      } catch (error) {
        fail(action.plugin, error)
      }
    },
    [host, fail],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isImeKey(e) || sheetOpen()) return
      // A key the user has given an app command since stays the app's.
      const found = keys.find((k) => keyMatches(k.key, e) && !takenByApp(k.key))
      if (!found) return
      e.preventDefault()
      void act({ kind: 'command', plugin: found.plugin, id: found.command })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keys, act])

  useMenuEvent(PLUGIN_ACTION_TAURI, PLUGIN_ACTION, (payload) => {
    if (isAction(payload)) void act(payload)
  })

  useEffect(() => {
    const el = dialog.current
    showFrame(frames.current, panel?.plugin ?? null, panel?.height ?? 0)
    if (!el) return
    if (panel && !el.open) {
      el.showModal()
      frames.current?.querySelector<HTMLIFrameElement>('iframe:not([hidden])')?.focus()
    } else if (!panel && el.open) {
      el.close()
    }
  }, [panel])

  const closePanel = () => {
    if (!panel) return
    host?.hidden(panel.plugin)
    setPanel(null)
  }

  const items = useMemo(() => pluginItems(plugins), [plugins])

  /** The palette's entries for plugins' commands and formats; exports only while a note is open. */
  const entries = (noteOpen: boolean): PaletteEntry[] =>
    items.flatMap((item): PaletteEntry[] => {
      if (item.kind === 'export' && !noteOpen) return []
      const label =
        item.kind === 'command'
          ? item.title
          : format(t(item.kind === 'import' ? 'plugins.importAs' : 'plugins.exportAs'), {
              title: item.title,
            })
      return [{ kind: 'command', id: actionEntryId(item), label, description: item.pluginName }]
    })

  const sheet: ReactNode = (
    <dialog
      ref={dialog}
      className="plugin-panel"
      aria-label={panel ? nameOf(panel.plugin) : undefined}
      onCancel={(e) => {
        e.preventDefault()
        closePanel()
      }}
    >
      <div className="plugin-panel-bar">
        <span className="plugin-panel-title">{panel ? nameOf(panel.plugin) : null}</span>
        <button type="button" className="button" onClick={closePanel}>
          {t('plugins.panelClose')}
        </button>
      </div>
      <div ref={frames} className="plugin-frames" />
    </dialog>
  )

  const notice: ReactNode = failure ? (
    <div role="alert" className="notice" data-devot-part="notice" data-devot-plugin-notice>
      <span className="notice-text">{format(t('plugins.failed'), failure)}</span>
      <button type="button" className="button" onClick={() => setFailure(undefined)}>
        {t('notice.dismiss')}
      </button>
    </div>
  ) : null

  return { entries, act, sheet, notice }
}
