import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseManifest,
  type InstalledPlugin,
  type JsonValue,
  type PluginPermission,
} from '../../../core/plugins'
import { createPluginHost, type PluginHostDeps, type PortLike } from './host'

type Message = Record<string, unknown>

/** A plugin's end of the port: answers host calls with `answer` and records what the host answers it. */
function fakePlugin(answer: (method: string, params: Message) => unknown = () => null) {
  const channel = new MessageChannel()
  const results: Message[] = []
  const events: unknown[] = []
  let seq = 0
  const waiting = new Map<number, (m: Message) => void>()
  channel.port2.onmessage = (event: MessageEvent<Message>) => {
    const m = event.data
    if (m['kind'] === 'call') {
      Promise.resolve()
        .then(() => answer(m['method'] as string, m['params'] as Message))
        .then(
          (value) =>
            channel.port2.postMessage({
              devot: 1,
              kind: 'result',
              seq: m['seq'],
              ok: true,
              value,
            }),
          (e: Error) =>
            channel.port2.postMessage({
              devot: 1,
              kind: 'result',
              seq: m['seq'],
              ok: false,
              code: e.message,
            }),
        )
    } else if (m['kind'] === 'result') {
      results.push(m)
      waiting.get(m['seq'] as number)?.(m)
    } else if (m['kind'] === 'event') {
      events.push(m['value'] === undefined ? m['name'] : [m['name'], m['value']])
    }
  }
  return {
    port: channel.port1 as unknown as PortLike,
    close: () => channel.port1.close(),
    /** Sends a raw message as the plugin and resolves with the host's answer. */
    call(method: string, params?: unknown, extra: Message = {}): Promise<Message> {
      seq += 1
      const at = seq
      return new Promise((resolve) => {
        waiting.set(at, resolve)
        channel.port2.postMessage({
          devot: 1,
          kind: 'call',
          seq: at,
          method,
          params,
          ...extra,
        })
      })
    },
    results,
    events,
    end: () => channel.port2.close(),
  }
}

function plugin(id: string, granted: PluginPermission[], enabled = true): InstalledPlugin {
  const manifest = parseManifest({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 2,
    main: 'main.js',
    permissions: [
      'note.read',
      'note.edit',
      'commands',
      'preview',
      'import',
      'export',
      'storage',
      'notes.read',
    ],
    contributes: { commands: [{ id: 'go', title: 'Go' }] },
  })
  return { manifest, enabled, granted }
}

const NOTES = [
  { id: 'n1', title: 'Plan', notebook: null, createdAt: 1, updatedAt: 3 },
  { id: 'n2', title: 'Plan B', notebook: null, createdAt: 1, updatedAt: 2 },
  { id: 'n3', title: 'Diary', notebook: null, createdAt: 1, updatedAt: 1 },
]

function setup(answers: Record<string, ReturnType<typeof fakePlugin>>, note = 'body') {
  const warnings: [string, string][] = []
  let text = note
  const stored = new Map<string, JsonValue>()
  const deps: PluginHostDeps = {
    connect: async (p) => {
      const fake = answers[p.manifest.id]
      if (!fake) throw new Error('E_PLUGIN_LOAD_TIMEOUT')
      return { port: fake.port, close: fake.close }
    },
    readNote: async () => ({ title: 'Plan', markdown: text }),
    replaceNote: async ({ base, markdown }) => {
      if (base !== text) throw new Error('E_PLUGIN_NOTE_CHANGED')
      text = markdown
    },
    // The fake editor selects the note's first word.
    readSelection: async () => {
      const to = text.search(/\s|$/)
      return { from: 0, to, text: text.slice(0, to) }
    },
    insertText: async ({ text: given, selected }) => {
      const to = text.search(/\s|$/)
      if (selected !== null && selected !== text.slice(0, to)) {
        throw new Error('E_PLUGIN_NOTE_CHANGED')
      }
      text = given + text.slice(to)
    },
    storage: {
      get: async (p, key) => stored.get(`${p} ${key}`) ?? null,
      set: async (p, key, value) => void stored.set(`${p} ${key}`, value),
      delete: async (p, key) => void stored.delete(`${p} ${key}`),
      keys: async (p) =>
        [...stored.keys()].filter((k) => k.startsWith(`${p} `)).map((k) => k.slice(p.length + 1)),
    },
    notes: {
      list: async (limit) => NOTES.slice(0, limit),
      search: async (query, limit) => NOTES.filter((n) => n.title.includes(query)).slice(0, limit),
      get: async (id) => {
        const found = NOTES.find((n) => n.id === id)
        if (!found) throw new Error('E_PLUGIN_NOTE_NOT_FOUND')
        return {
          id,
          title: found.title,
          notebook: null,
          markdown: `# ${found.title}`,
        }
      },
      notebooks: async () => [{ id: 'b1', name: 'Work', parent: null }],
    },
    settings: async (p) => ({ unit: p === 'com.a' ? 'km' : 'mi' }),
    showUi: vi.fn<PluginHostDeps['showUi']>(),
    hideUi: vi.fn<PluginHostDeps['hideUi']>(),
    warn: (code, id) => warnings.push([code, id]),
  }
  return {
    host: createPluginHost(deps),
    deps,
    warnings,
    text: () => text,
    stored,
  }
}

afterEach(() => vi.useRealTimers())

describe('the plugin host', () => {
  it('runs a command, during which the plugin may read and replace the open note', async () => {
    let fake!: ReturnType<typeof fakePlugin>
    const seen: Message[] = []
    fake = fakePlugin(async (method, params) => {
      if (method !== 'command.run') return null
      seen.push(params)
      const read = await fake.call('note.read')
      const value = read['value'] as { markdown: string }
      seen.push(read)
      seen.push(
        await fake.call('note.replace', {
          base: value.markdown,
          markdown: 'BODY',
        }),
      )
      return null
    })
    const { host, text } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['note.read', 'note.edit', 'commands'])])
    await host.run('com.a', 'go')
    expect(seen[0]).toEqual({ command: 'go' })
    expect(seen[1]).toMatchObject({
      ok: true,
      value: { title: 'Plan', markdown: 'body' },
    })
    expect(seen[2]).toMatchObject({ ok: true })
    expect(text()).toBe('BODY')
  })

  it('refuses note calls outside a command, and without their permission', async () => {
    let fake!: ReturnType<typeof fakePlugin>
    let during: Message | undefined
    fake = fakePlugin(async (method) => {
      if (method === 'command.run')
        during = await fake.call('note.replace', {
          base: 'body',
          markdown: 'x',
        })
      return null
    })
    const { host, warnings, text } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['note.read', 'commands'])])
    await host.run('com.a', 'go')
    expect(during).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
    expect(await fake.call('note.read')).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_NOT_ACTIVE',
    })
    expect(text()).toBe('body')
    expect(warnings).toContainEqual(['E_PLUGIN_PERMISSION_DENIED', 'com.a'])
  })

  it('answers unknown methods with a code and acts on none of them', async () => {
    const fake = fakePlugin()
    const { host } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['note.read', 'note.edit', 'commands'])])
    await host.run('com.a', 'go')
    for (const method of ['invoke', 'plugin_install_confirm', 'note.list']) {
      expect(await fake.call(method, { cmd: 'notes_list' })).toMatchObject({
        ok: false,
        code: 'E_PLUGIN_METHOD_UNKNOWN',
      })
    }
  })

  it('binds each port to its plugin, whatever a message claims', async () => {
    let a!: ReturnType<typeof fakePlugin>
    let claimed: Message | undefined
    a = fakePlugin(async (method) => {
      if (method === 'command.run') {
        claimed = await a.call('note.read', undefined, {
          plugin: 'com.b',
          from: 'com.b',
        })
      }
      return null
    })
    const b = fakePlugin()
    const { host } = setup({ 'com.a': a, 'com.b': b })
    // com.b may read the note; com.a, claiming to be com.b, may not.
    host.load([plugin('com.a', ['commands']), plugin('com.b', ['note.read', 'commands'])])
    await host.run('com.a', 'go')
    expect(claimed).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
  })

  it('lets a plugin show its panel only while a command of it runs', async () => {
    let fake!: ReturnType<typeof fakePlugin>
    fake = fakePlugin(async (method) => {
      if (method === 'command.run') await fake.call('ui.show', { height: 200 })
      return null
    })
    const { host, deps } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['commands'])])
    expect(await fake.call('ui.show', { height: 200 })).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_NOT_ACTIVE',
    })
    await host.run('com.a', 'go')
    expect(deps.showUi).toHaveBeenCalledWith('com.a', 200)
    // While the panel is open, the plugin is active.
    expect(await fake.call('note.read')).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
    host.hidden('com.a')
    expect(await fake.call('ui.show', {})).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_NOT_ACTIVE',
    })
  })

  it('checks what a plugin answers', async () => {
    const fake = fakePlugin((method, params) => {
      if (method === 'preview.render') return params['source'] === 'bad' ? { html: '<b>' } : '**b**'
      if (method === 'import.convert') return { title: 'T', markdown: String(params['text']) }
      if (method === 'export.convert') return `* ${String(params['markdown'])}`
      return null
    })
    const { host } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['commands', 'preview', 'import', 'export'])])
    expect(await host.render('com.a', 'r', 'x')).toBe('**b**')
    await expect(host.render('com.a', 'r', 'bad')).rejects.toThrow('E_PLUGIN_RESULT_INVALID')
    expect(await host.convertImport('com.a', 'f', { name: 'a.org', text: 'x' })).toEqual({
      title: 'T',
      markdown: 'x',
    })
    expect(await host.convertExport('com.a', 'f', { title: 'T', markdown: 'x' })).toBe('* x')
  })

  it('gives up on a plugin that does not answer in time', async () => {
    vi.useFakeTimers()
    const fake = fakePlugin(() => new Promise(() => {}))
    const { host, warnings } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['preview'])])
    const rendering = host.render('com.a', 'r', 'x').catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await rendering).toBe('E_PLUGIN_TIMEOUT')
    expect(warnings).toContainEqual(['E_PLUGIN_TIMEOUT', 'com.a'])
  })

  it('never passes a plugin failure text on, only a code', async () => {
    const fake = fakePlugin(() => {
      throw new Error('the note said: secret')
    })
    const { host } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['commands'])])
    await expect(host.run('com.a', 'go')).rejects.toThrow(/^E_PLUGIN_FAILED$/)
  })

  it('stops plugins turned off or changed, and their waiting calls fail', async () => {
    const fake = fakePlugin(() => new Promise(() => {}))
    const { host } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['commands'])])
    const running = host.run('com.a', 'go')
    await new Promise((r) => setTimeout(r, 0))
    host.load([plugin('com.a', ['commands'], false)])
    await expect(running).rejects.toThrow('E_PLUGIN_STOPPED')
    await expect(host.run('com.a', 'go')).rejects.toThrow('E_PLUGIN_NOT_FOUND')
  })

  it('starts a plugin installed again afresh, and leaves one that did not change running', async () => {
    const connects: string[] = []
    const host = createPluginHost({
      connect: async (p) => {
        connects.push(`${p.manifest.id} ${p.installedAt}`)
        const fake = fakePlugin()
        return { port: fake.port, close: fake.close }
      },
      readNote: async () => null,
      replaceNote: async () => {},
      readSelection: async () => null,
      insertText: async () => {},
      storage: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        keys: async () => [],
      },
      notes: {
        list: async () => [],
        search: async () => [],
        get: async () => {
          throw new Error('E_PLUGIN_NOTE_NOT_FOUND')
        },
        notebooks: async () => [],
      },
      settings: async () => ({}),
      showUi: () => {},
      hideUi: () => {},
      warn: () => {},
    })
    const first = { ...plugin('com.a', ['commands']), installedAt: 1 }
    host.load([first])
    host.load([first])
    host.load([{ ...first, installedAt: 2 }])
    await host.run('com.a', 'go')
    expect(connects).toEqual(['com.a 1', 'com.a 2'])
  })

  it('reports a plugin whose frame never connected', async () => {
    const { host, warnings } = setup({})
    host.load([plugin('com.gone', ['commands'])])
    await expect(host.run('com.gone', 'go')).rejects.toThrow('E_PLUGIN_LOAD_TIMEOUT')
    expect(warnings[0]).toEqual(['E_PLUGIN_LOAD_TIMEOUT', 'com.gone'])
  })

  it('starts a plugin whose frame failed to connect again on the next request', async () => {
    const answers: Record<string, ReturnType<typeof fakePlugin>> = {}
    const { host } = setup(answers)
    host.load([plugin('com.late', ['commands'])])
    await expect(host.run('com.late', 'go')).rejects.toThrow('E_PLUGIN_LOAD_TIMEOUT')
    answers['com.late'] = fakePlugin()
    await expect(host.run('com.late', 'go')).resolves.toBeUndefined()
  })

  it('leaves a plugin inactive once another plugin shows its panel in its place', async () => {
    const answer = (fake: () => ReturnType<typeof fakePlugin>) => async (method: string) => {
      if (method === 'command.run') await fake().call('ui.show', { height: 100 })
      return null
    }
    let a!: ReturnType<typeof fakePlugin>
    let b!: ReturnType<typeof fakePlugin>
    a = fakePlugin(answer(() => a))
    b = fakePlugin(answer(() => b))
    const { host } = setup({ 'com.a': a, 'com.b': b })
    host.load([plugin('com.a', ['note.read', 'commands']), plugin('com.b', ['commands'])])
    await host.run('com.a', 'go')
    expect(await a.call('note.read')).toMatchObject({ ok: true })
    await host.run('com.b', 'go')
    expect(await a.call('note.read')).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_NOT_ACTIVE',
    })
    expect(a.events).toEqual(['ui.hidden'])
  })

  it('keeps the values of each plugin apart, at any time, only with the storage permission', async () => {
    const a = fakePlugin()
    const b = fakePlugin()
    const { host, stored, warnings } = setup({ 'com.a': a, 'com.b': b })
    host.load([plugin('com.a', ['storage']), plugin('com.b', ['commands'])])
    await host.run('com.b', 'go')
    expect(await a.call('storage.set', { key: 'n', value: { count: 2 } })).toMatchObject({
      ok: true,
    })
    expect(await a.call('storage.get', { key: 'n' })).toMatchObject({
      ok: true,
      value: { count: 2 },
    })
    expect(await a.call('storage.keys')).toMatchObject({
      ok: true,
      value: ['n'],
    })
    expect(await b.call('storage.get', { key: 'n' })).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
    expect(await a.call('storage.delete', { key: 'n' })).toMatchObject({
      ok: true,
    })
    expect(stored.size).toBe(0)
    expect(warnings).toContainEqual(['E_PLUGIN_PERMISSION_DENIED', 'com.b'])
  })

  it('hands a plugin its own settings and tells it when they change', async () => {
    const a = fakePlugin()
    const b = fakePlugin()
    const { host } = setup({ 'com.a': a, 'com.b': b })
    host.load([plugin('com.a', ['commands']), plugin('com.b', ['commands'])])
    await host.run('com.a', 'go')
    await host.run('com.b', 'go')
    expect(await a.call('settings.get')).toMatchObject({
      ok: true,
      value: { unit: 'km' },
    })
    expect(await b.call('settings.get')).toMatchObject({
      ok: true,
      value: { unit: 'mi' },
    })
    host.settingsChanged('com.a')
    await vi.waitFor(() => expect(a.events).toEqual(['settings.changed']))
    expect(b.events).toEqual([])
  })

  it('lists, searches and reads notes for a plugin with notes.read, at any time', async () => {
    const a = fakePlugin()
    const b = fakePlugin()
    const { host } = setup({ 'com.a': a, 'com.b': b })
    host.load([plugin('com.a', ['notes.read']), plugin('com.b', ['commands'])])
    await host.run('com.b', 'go')
    expect(await a.call('notes.list', { limit: 2 })).toMatchObject({
      ok: true,
      value: [{ id: 'n1' }, { id: 'n2' }],
    })
    expect(await a.call('notes.search', { query: 'Plan' })).toMatchObject({
      ok: true,
      value: [{ id: 'n1' }, { id: 'n2' }],
    })
    expect(await a.call('notes.get', { id: 'n3' })).toMatchObject({
      ok: true,
      value: { id: 'n3', title: 'Diary', markdown: '# Diary' },
    })
    expect(await a.call('notes.get', { id: 'gone' })).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_NOTE_NOT_FOUND',
    })
    expect(await a.call('notebooks.list')).toMatchObject({
      ok: true,
      value: [{ id: 'b1', name: 'Work' }],
    })
    expect(await b.call('notes.list')).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
  })

  it('reads the selection and writes in its place during a command, and only then', async () => {
    let fake!: ReturnType<typeof fakePlugin>
    const seen: Message[] = []
    fake = fakePlugin(async (method) => {
      if (method !== 'command.run') return null
      seen.push(await fake.call('note.selection'))
      seen.push(await fake.call('note.insert', { text: 'Big', selected: 'stale' }))
      seen.push(await fake.call('note.insert', { text: 'Big', selected: 'small' }))
      return null
    })
    const { host, text } = setup({ 'com.a': fake }, 'small plan')
    host.load([plugin('com.a', ['note.read', 'note.edit', 'commands'])])
    await host.run('com.a', 'go')
    expect(seen).toMatchObject([
      { ok: true, value: { from: 0, to: 5, text: 'small' } },
      { ok: false, code: 'E_PLUGIN_NOTE_CHANGED' },
      { ok: true, value: null },
    ])
    expect(text()).toBe('Big plan')
    expect(await fake.call('note.selection')).toMatchObject({
      code: 'E_PLUGIN_NOT_ACTIVE',
    })
    expect(await fake.call('note.insert', { text: 'x' })).toMatchObject({
      code: 'E_PLUGIN_NOT_ACTIVE',
    })
  })

  it('refuses a write at the selection without note.edit', async () => {
    let fake!: ReturnType<typeof fakePlugin>
    let during: Message | undefined
    fake = fakePlugin(async (method) => {
      if (method === 'command.run') during = await fake.call('note.insert', { text: 'x' })
      return null
    })
    const { host, text } = setup({ 'com.a': fake })
    host.load([plugin('com.a', ['note.read', 'commands'])])
    await host.run('com.a', 'go')
    expect(during).toMatchObject({
      ok: false,
      code: 'E_PLUGIN_PERMISSION_DENIED',
    })
    expect(text()).toBe('body')
  })

  it('tells plugins with notes.read which note opens, and a plugin that starts later the one open', async () => {
    const a = fakePlugin()
    const b = fakePlugin()
    const c = fakePlugin()
    const { host } = setup({ 'com.a': a, 'com.b': b, 'com.c': c })
    host.load([plugin('com.a', ['notes.read']), plugin('com.b', ['note.read', 'commands'])])
    host.noteOpened('n1')
    host.noteOpened('n1')
    host.noteOpened(null)
    await vi.waitFor(() =>
      expect(a.events).toEqual([
        ['note.opened', { id: 'n1' }],
        ['note.opened', { id: null }],
      ]),
    )
    host.noteOpened('n2')
    host.load([
      plugin('com.a', ['notes.read']),
      plugin('com.b', ['note.read', 'commands']),
      plugin('com.c', ['notes.read']),
    ])
    await vi.waitFor(() => expect(c.events).toEqual([['note.opened', { id: 'n2' }]]))
    await host.run('com.b', 'go')
    expect(b.events).toEqual([])
  })
})
