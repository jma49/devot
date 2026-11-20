// Plugins in the main window (ADR 0005): their frames, the host that speaks to them, and what they contribute: palette entries,
// keys, preview renderers, menu bar picks (`devot://plugin-action`), import and export formats, and the sheet a plugin's UI shows in.
import * as Comlink from 'comlink'
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { InstalledPlugin } from '../../../core/plugins'
import type { PluginRendererSpec } from '../../../core/preview'
import { errorCode } from '../../../core/errors'
import { sheetOpen, useMenuEvent } from '../commands/dispatch'
import { keyMatches } from '../commands/keys'
import { COMMANDS, commandKeys, RESERVED_KEYS } from '../commands/registry'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { setSlashPlugins } from '../editor/slashPlugins'
import { format, t } from '../i18n'
import { isImeKey } from '../ime'
import { editingAllowed, LICENCE_REQUIRED, openLicenceSettings } from '../licence'
import type { PaletteEntry } from '../palette/results'
import {
  listPlugins,
  pickImportFiles,
  PLUGIN_ACTION,
  PLUGIN_ACTION_TAURI,
  saveExport,
  watchPlugins,
  pluginSettings,
  pluginStorage,
  watchPluginSettings,
} from './api'
import {
  actionEntryId,
  pluginItems,
  pluginKeys,
  rendererOfKey,
  drawsFromLibrary,
  editableRenderers,
  rendererSpecs,
  slashCommands,
  type PluginAction,
} from './contributions'
import { frameConnector, showFrame } from './frames'
import { createPluginHost, type PluginHost, type PluginNotes } from './host'
import { useLibraryTurn } from './libraryTurn'
import { pluginRenderersChanged } from './rendererRevision'
import { keptDrawingsChanged } from '../preview/keptDrawings'
import { setPluginDrawer } from '../preview/pluginDrawing'
import { failureText, logFailure } from '../failure'
import { useStable } from '../stable'
import { importPluginFiles, readPluginFiles, routeImport } from './importFiles'

export interface PluginWindow {
  /** The note open in the editor. */
  openNote(): { id: string } | undefined
  /** Applies a Yjs update the core returned to the editor, as one undo step, if it still shows the note. */
  applyUpdate(noteId: string, update: Uint8Array): void
  /** The editor, while it is ready. */
  editor(): Pick<
    EditorHandle,
    'noteId' | 'pluginSelection' | 'pluginInsert' | 'pluginBlockEdit'
  > | null
  /** Where imported notes go: the notebook shown, or none. */
  importBook(): string | null
  /** The lists show what an import made. */
  imported(): void
}

/** The notes plugins read load on a plugin's first read, so the main window starts without them. */
function lazyNotes(core: () => Core | undefined): PluginNotes {
  const loaded = () => import('./notes').then(({ pluginNotes }) => pluginNotes(core))
  return {
    list: async (limit) => (await loaded()).list(limit),
    search: async (query, limit) => (await loaded()).search(query, limit),
    get: async (id) => (await loaded()).get(id),
    notebooks: async () => (await loaded()).notebooks(),
  }
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
  useInsertionEffect(() => {
    latest.current = { core, app, plugins }
  })

  const [host, setHost] = useState<PluginHost>()
  useEffect(() => {
    // The editor counts only while it shows the open note: never a note it is still leaving.
    const shownEditor = () => {
      const { app: w } = latest.current
      const editor = w.editor()
      const open = w.openNote()
      return editor && open && editor.noteId === open.id ? editor : null
    }
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
        if (!editingAllowed()) throw new Error('E_LICENCE_REQUIRED')
        w.applyUpdate(open.id, await c.applyPluginEdit(open.id, edit))
      },
      readSelection: async () => shownEditor()?.pluginSelection() ?? null,
      insertText: async ({ text, selected }) => {
        const editor = shownEditor()
        if (!editor) throw new Error('E_PLUGIN_NO_NOTE')
        if (!editingAllowed()) throw new Error('E_LICENCE_REQUIRED')
        const refused = editor.pluginInsert(text, selected)
        if (refused) throw new Error(refused)
      },
      storage: pluginStorage,
      notes: lazyNotes(() => latest.current.core ?? undefined),
      settings: pluginSettings,
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

  const openId = app.openNote()?.id ?? null
  useEffect(() => host?.noteOpened(openId), [host, openId])

  useEffect(
    () => (host ? watchPluginSettings((plugin) => host.settingsChanged(plugin)) : undefined),
    [host],
  )

  const nameOf = useCallback(
    (id: string) => plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id,
    [plugins],
  )
  const fail = useCallback(
    (plugin: string, error: unknown) =>
      setFailure({
        name: nameOf(plugin),
        code: logFailure(errorCode(error, 'E_PLUGIN_FAILED'), 'W_PLUGIN_FAILED'),
      }),
    [nameOf],
  )

  // The worker renders the preview again only when the renderers change: never for a list that stays without any.
  const libraryTurn = useLibraryTurn(drawsFromLibrary(plugins))
  const specsKey = JSON.stringify(rendererSpecs(plugins))
  const drawnKey = `${specsKey}#${libraryTurn}`
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

  useEffect(() => {
    if (!core || libraryTurn === 0) return
    void core
      .pluginNotesChanged()
      .then(pluginRenderersChanged, () => console.warn('W_PLUGIN_RENDERERS_FAILED'))
  }, [core, libraryTurn])

  const editableKey = JSON.stringify(editableRenderers(plugins))
  useEffect(() => {
    if (!host) return
    const editBlock = async (key: string, source: string, at: { from: number; to: number }) => {
      const target = rendererOfKey(key)
      if (!target) return
      try {
        if (!editingAllowed()) throw new Error(LICENCE_REQUIRED)
        const { app: w } = latest.current
        const noteId = w.openNote()?.id
        const text = await host.edit(target.plugin, target.renderer, source)
        if (text === null) return
        const editor = w.editor()
        if (!noteId || editor?.noteId !== noteId) throw new Error('E_PLUGIN_NOTE_CHANGED')
        const refused = await editor.pluginBlockEdit({ ...at, source }, text)
        if (refused) throw new Error(refused)
      } catch (error) {
        fail(target.plugin, error)
      }
    }
    setPluginDrawer(
      (key, source, theme) => {
        const target = rendererOfKey(key)
        return target
          ? host.render(target.plugin, target.renderer, source, theme)
          : Promise.resolve(null)
      },
      `${drawnKey}#${editableKey}`,
      { editable: new Set(JSON.parse(editableKey) as string[]), edit: editBlock },
      (noteId, { key, content, appearance, svg }) => {
        const target = rendererOfKey(key)
        const spec = (JSON.parse(specsKey) as PluginRendererSpec[]).find((s) => s.key === key)
        const c = latest.current.core
        if (!c || !target || !spec) return
        void c
          .keepPluginDrawing(noteId, {
            pluginId: target.plugin,
            language: spec.language,
            content,
            appearance,
            svg,
          })
          .then(
            (kept) => kept && keptDrawingsChanged(new Set([noteId])),
            () => console.warn('W_PLUGIN_DRAWING_KEEP_FAILED'),
          )
      },
    )
    return () => setPluginDrawer(undefined, '')
  }, [host, drawnKey, editableKey, specsKey, fail])

  const keys = useMemo(() => {
    const { keys: given, dropped } = pluginKeys(plugins, takenByApp)
    for (const d of dropped) console.warn('W_PLUGIN_KEY_TAKEN', d.plugin, d.command)
    return given
  }, [plugins])

  const convertFiles = useStable(
    async (
      pluginId: string,
      formatId: string,
      files: { name: string; text: string }[],
      destination: string | null,
    ) => {
      const { core: c, app: w, plugins: installed } = latest.current
      const plugin = installed.find((item) => item.manifest.id === pluginId)
      if (!c || !host || !plugin) throw new Error('E_PLUGIN_STOPPED')
      let failed = false
      const ids = await importPluginFiles(
        plugin,
        formatId,
        files,
        host,
        c,
        destination,
        editingAllowed,
        (error) => {
          failed = true
          fail(pluginId, error)
        },
      )
      if (ids.length) w.imported()
      return { ids, failed }
    },
  )

  const importDropped = useStable(async (files: File[], destination: string | null) => {
    const read = await readPluginFiles(files)
    const groups = new Map<string, { plugin: string; format: string; files: typeof read }>()
    for (const file of read) {
      const route = routeImport(file.name, latest.current.plugins)
      if (route.kind !== 'plugin') throw new Error('E_PLUGIN_FORMAT_UNKNOWN')
      const key = `${route.plugin.manifest.id}/${route.format}`
      let group = groups.get(key)
      if (!group) {
        group = { plugin: route.plugin.manifest.id, format: route.format, files: [] }
        groups.set(key, group)
      }
      group.files.push(file)
    }
    const ids: string[] = []
    let failed = false
    for (const group of groups.values()) {
      const result = await convertFiles(group.plugin, group.format, group.files, destination)
      ids.push(...result.ids)
      failed ||= result.failed
    }
    return { ids, failed }
  })

  const act = useCallback(
    async (action: PluginAction) => {
      const { core: c, app: w } = latest.current
      if (!host) return
      try {
        // An import makes notes, so it is refused like the app's own changes are; a command's edit is refused in replaceNote.
        if (action.kind === 'import' && !editingAllowed()) throw new Error('E_LICENCE_REQUIRED')
        if (action.kind === 'command') {
          await host.run(action.plugin, action.id)
        } else if (action.kind === 'import') {
          if (!c) return
          const files = await pickImportFiles(action.plugin, action.id)
          if (!files) return
          await convertFiles(action.plugin, action.id, files, w.importBook())
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
    [host, fail, convertFiles],
  )

  const slash = useMemo(() => slashCommands(plugins), [plugins])
  useEffect(() => {
    setSlashPlugins(slash, (plugin, id) => void act({ kind: 'command', plugin, id }))
    return () => setSlashPlugins([], null)
  }, [slash, act])

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

  /** The palette's entries for plugins' commands and formats; exports only while a note is open, and imports only while editing is allowed. */
  const entries = (noteOpen: boolean): PaletteEntry[] =>
    items.flatMap((item): PaletteEntry[] => {
      if (item.kind === 'export' && !noteOpen) return []
      if (item.kind === 'import' && !editingAllowed()) return []
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

  const licenceRefused = failure?.code === LICENCE_REQUIRED
  const notice: ReactNode = failure ? (
    <div role="alert" className="notice" data-devot-part="notice" data-devot-plugin-notice>
      <span className="notice-text">
        {licenceRefused
          ? t('plugins.trialEnded')
          : failureText('plugins.failed', failure.code, { name: failure.name })}
      </span>
      {licenceRefused ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            setFailure(undefined)
            openLicenceSettings()
          }}
        >
          {t('licenceSettings.add')}
        </button>
      ) : null}
      <button type="button" className="button" onClick={() => setFailure(undefined)}>
        {t('notice.dismiss')}
      </button>
    </div>
  ) : null

  return { entries, act, sheet, notice, installed: plugins, importDropped }
}
