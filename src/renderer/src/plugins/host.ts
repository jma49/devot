// The main window's side of the plugin protocol (ADR 0005). Each plugin has a session bound to the port of the frame the host
// made for it, so a message is always that plugin's, whatever it says. Every call is checked (core/plugins/protocol.ts) before
// the host acts; failures are logged with the plugin's ID and a code, never content.
import {
  checkCall,
  checkResult,
  effectivePermissions,
  HOST_CALL_TIMEOUT_MS,
  MAX_PENDING_CALLS,
  PLUGIN_PROTOCOL_VERSION,
  readMessage,
  type CallMessage,
  type Converted,
  type HostMethod,
  type InstalledPlugin,
  type JsonValue,
  type PluginCall,
  type PluginPermission,
} from '../../../core/plugins'
import { errorCode } from '../../../core/errors'

export type PortLike = MessagePort

export interface Connection {
  port: PortLike
  close(): void
}

export interface OpenNote {
  title: string
  markdown: string
}

export interface PluginHostDeps {
  connect(plugin: InstalledPlugin): Promise<Connection>
  /** The note open in the editor, or null. */
  readNote(): Promise<OpenNote | null>
  /** Throws E_PLUGIN_NO_NOTE without an open note, E_PLUGIN_NOTE_CHANGED when it is no longer `base`. */
  replaceNote(edit: { base: string; markdown: string }): Promise<void>
  /** The plugin's own store (Rust checks its `storage` permission again). */
  storage: PluginStorage
  /** Every setting the plugin's manifest declares, with its value. */
  settings(plugin: string): Promise<Record<string, unknown>>
  showUi(plugin: string, height: number): void
  hideUi(plugin: string): void
  warn(code: string, plugin: string): void
}

export interface PluginStorage {
  get(plugin: string, key: string): Promise<JsonValue | null>
  set(plugin: string, key: string, value: JsonValue): Promise<void>
  delete(plugin: string, key: string): Promise<void>
  keys(plugin: string): Promise<string[]>
}

export interface PluginHost {
  /** Starts the enabled plugins not running yet, and stops those gone, turned off or changed. */
  load(plugins: readonly InstalledPlugin[]): void
  run(plugin: string, command: string): Promise<void>
  render(plugin: string, renderer: string, source: string): Promise<string | null>
  convertImport(
    plugin: string,
    format: string,
    file: { name: string; text: string },
  ): Promise<Converted>
  convertExport(plugin: string, format: string, note: OpenNote): Promise<string>
  /** The user closed the plugin's panel. */
  hidden(plugin: string): void
  /** The user changed one of the plugin's settings. */
  settingsChanged(plugin: string): void
  stop(): void
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  id: string
  key: string
  granted: ReadonlySet<PluginPermission>
  ready: Promise<PortLike>
  connection?: Connection
  waiting: Map<number, Waiting>
  seq: number
  running: number
  shown: boolean
  calls: number
  stopped: boolean
}

const sessionKey = (p: InstalledPlugin) =>
  JSON.stringify([p.installedAt ?? 0, p.manifest.version, p.manifest.main, [...p.granted].sort()])

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const sessions = new Map<string, Session>()
  let wanted = new Map<string, InstalledPlugin>()

  const tell = (s: Session, name: 'ui.hidden' | 'settings.changed') =>
    s.ready
      .then((port) => {
        if (!s.stopped) port.postMessage({ devot: PLUGIN_PROTOCOL_VERSION, kind: 'event', name })
      })
      .catch(() => {})

  const markHidden = (s: Session) => {
    if (!s.shown) return
    s.shown = false
    void tell(s, 'ui.hidden')
  }

  const reply = (
    port: PortLike,
    seq: number,
    result: { ok: true; value: unknown } | { ok: false; code: string },
  ) => port.postMessage({ devot: PLUGIN_PROTOCOL_VERSION, kind: 'result', seq, ...result })

  const perform = async (s: Session, call: PluginCall): Promise<unknown> => {
    switch (call.method) {
      case 'note.read': {
        const note = await deps.readNote()
        if (!note) throw new Error('E_PLUGIN_NO_NOTE')
        return { title: note.title, markdown: note.markdown }
      }
      case 'note.replace':
        await deps.replaceNote({ base: call.base, markdown: call.markdown })
        return null
      case 'ui.show':
        // One panel shows at a time: the plugin whose panel it replaces is no longer active.
        for (const other of sessions.values()) if (other !== s) markHidden(other)
        s.shown = true
        deps.showUi(s.id, call.height)
        return null
      case 'ui.hide':
        s.shown = false
        deps.hideUi(s.id)
        return null
      case 'storage.get':
        return deps.storage.get(s.id, call.key)
      case 'storage.set':
        await deps.storage.set(s.id, call.key, call.value)
        return null
      case 'storage.delete':
        await deps.storage.delete(s.id, call.key)
        return null
      case 'storage.keys':
        return deps.storage.keys(s.id)
      case 'settings.get':
        return deps.settings(s.id)
    }
  }

  const handleCall = async (s: Session, port: PortLike, call: CallMessage) => {
    if (s.calls >= MAX_PENDING_CALLS) {
      deps.warn('E_PLUGIN_BUSY', s.id)
      return reply(port, call.seq, { ok: false, code: 'E_PLUGIN_BUSY' })
    }
    const checked = checkCall(call, { granted: s.granted, active: s.running > 0 || s.shown })
    if (!checked.ok) {
      deps.warn(checked.code, s.id)
      return reply(port, call.seq, { ok: false, code: checked.code })
    }
    s.calls += 1
    try {
      const value = await perform(s, checked.call)
      if (!s.stopped) reply(port, call.seq, { ok: true, value })
    } catch (error) {
      const code = errorCode(error, 'E_PLUGIN_FAILED')
      deps.warn(code, s.id)
      if (!s.stopped) reply(port, call.seq, { ok: false, code })
    } finally {
      s.calls -= 1
    }
  }

  const connect = (plugin: InstalledPlugin, s: () => Session): Promise<PortLike> =>
    deps.connect(plugin).then(
      (connection) => {
        const session = s()
        if (session.stopped) {
          connection.close()
          throw new Error('E_PLUGIN_STOPPED')
        }
        session.connection = connection
        const { port } = connection
        port.onmessage = (event) => {
          const message = readMessage(event.data)
          if (!message || session.stopped) return
          if (message.kind === 'call') {
            void handleCall(session, port, message)
            return
          }
          const waiting = session.waiting.get(message.seq)
          if (!waiting) return
          session.waiting.delete(message.seq)
          clearTimeout(waiting.timer)
          if (message.ok) waiting.resolve(message.value)
          else waiting.reject(new Error(message.code))
        }
        return port
      },
      (error: unknown) => {
        const code = errorCode(error, 'E_PLUGIN_UNAVAILABLE')
        deps.warn(code, plugin.manifest.id)
        // Forgotten, so the next request starts the plugin again rather than failing on this load for good.
        const failed = s()
        if (sessions.get(failed.id) === failed) sessions.delete(failed.id)
        throw new Error(code)
      },
    )

  const start = (plugin: InstalledPlugin): Session => {
    const s: Session = {
      id: plugin.manifest.id,
      key: sessionKey(plugin),
      granted: effectivePermissions(plugin),
      ready: connect(plugin, () => s),
      waiting: new Map(),
      seq: 0,
      running: 0,
      shown: false,
      calls: 0,
      stopped: false,
    }
    s.ready.catch(() => {})
    return s
  }

  const end = (s: Session) => {
    s.stopped = true
    for (const waiting of s.waiting.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('E_PLUGIN_STOPPED'))
    }
    s.waiting.clear()
    if (s.shown) deps.hideUi(s.id)
    s.connection?.close()
  }

  const session = (id: string) => {
    const known = sessions.get(id)
    if (known) return known
    const plugin = wanted.get(id)
    if (!plugin) throw new Error('E_PLUGIN_NOT_FOUND')
    const s = start(plugin)
    sessions.set(id, s)
    return s
  }

  const request = async (id: string, method: HostMethod, params: Record<string, unknown>) => {
    const s = session(id)
    const port = await s.ready
    if (s.stopped) throw new Error('E_PLUGIN_STOPPED')
    if (s.waiting.size >= MAX_PENDING_CALLS) throw new Error('E_PLUGIN_BUSY')
    s.seq += 1
    const seq = s.seq
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.waiting.delete(seq)
        reject(new Error('E_PLUGIN_TIMEOUT'))
      }, HOST_CALL_TIMEOUT_MS[method])
      s.waiting.set(seq, { resolve, reject, timer })
      port.postMessage({ devot: PLUGIN_PROTOCOL_VERSION, kind: 'call', seq, method, params })
    }).catch((error: unknown) => {
      const code = errorCode(error, 'E_PLUGIN_FAILED')
      deps.warn(code, id)
      throw new Error(code)
    })
  }

  return {
    load(plugins) {
      wanted = new Map(plugins.filter((p) => p.enabled).map((p) => [p.manifest.id, p]))
      for (const [id, s] of sessions) {
        const next = wanted.get(id)
        if (!next || sessionKey(next) !== s.key) {
          end(s)
          sessions.delete(id)
        }
      }
      for (const [id, plugin] of wanted) if (!sessions.has(id)) sessions.set(id, start(plugin))
    },

    async run(plugin, command) {
      const s = session(plugin)
      s.running += 1
      try {
        checkResult('command.run', await request(plugin, 'command.run', { command }))
      } finally {
        s.running -= 1
      }
    },

    async render(plugin, renderer, source) {
      return checkResult(
        'preview.render',
        await request(plugin, 'preview.render', { renderer, source }),
      )
    },

    async convertImport(plugin, format, file) {
      return checkResult(
        'import.convert',
        await request(plugin, 'import.convert', { format, name: file.name, text: file.text }),
      )
    },

    async convertExport(plugin, format, note) {
      return checkResult(
        'export.convert',
        await request(plugin, 'export.convert', {
          format,
          title: note.title,
          markdown: note.markdown,
        }),
      )
    },

    hidden(plugin) {
      const s = sessions.get(plugin)
      if (s) markHidden(s)
    },

    settingsChanged(plugin) {
      const s = sessions.get(plugin)
      if (s) void tell(s, 'settings.changed')
    },

    stop() {
      for (const s of sessions.values()) end(s)
      sessions.clear()
      wanted = new Map()
    },
  }
}
