import { describe, expect, it } from 'vitest'
import { parseManifest, type InstalledPlugin, type PluginPermission } from '../../../core/plugins'
import {
  actionEntryId,
  actionOfEntry,
  pluginItems,
  pluginKeys,
  rendererOfKey,
  rendererSpecs,
  stopsImport,
} from './contributions'

const ALL: PluginPermission[] = ['commands', 'menus', 'keymaps', 'preview', 'import', 'export']

function plugin(
  id: string,
  options: {
    granted?: PluginPermission[]
    enabled?: boolean
    keys?: string[]
    language?: string
  } = {},
): InstalledPlugin {
  const keys = options.keys ?? ['Mod+Shift+U']
  const manifest = parseManifest({
    id,
    name: `Name ${id}`,
    version: '1.0.0',
    apiVersion: 1,
    main: 'main.js',
    permissions: ALL,
    contributes: {
      commands: keys.map((_, i) => ({ id: `c${i}`, title: `Command ${i}` })),
      keymaps: keys.map((key, i) => ({ command: `c${i}`, key })),
      previewRenderers: [{ id: 'r', language: options.language ?? 'chart' }],
      importFormats: [{ id: 'org', title: 'Org Files', extensions: ['org'] }],
      exportFormats: [{ id: 'org', title: 'Org', extension: 'org' }],
    },
  })
  return { manifest, enabled: options.enabled ?? true, granted: options.granted ?? ALL }
}

describe('plugin contributions', () => {
  it('lists the commands and formats of enabled plugins by what was granted', () => {
    expect(pluginItems([plugin('com.b', { granted: ['commands'] }), plugin('com.a')])).toEqual([
      { kind: 'command', plugin: 'com.a', id: 'c0', title: 'Command 0', pluginName: 'Name com.a' },
      { kind: 'import', plugin: 'com.a', id: 'org', title: 'Org Files', pluginName: 'Name com.a' },
      { kind: 'export', plugin: 'com.a', id: 'org', title: 'Org', pluginName: 'Name com.a' },
      { kind: 'command', plugin: 'com.b', id: 'c0', title: 'Command 0', pluginName: 'Name com.b' },
    ])
    expect(pluginItems([plugin('com.a', { enabled: false })])).toEqual([])
  })

  it('names palette entries so they never collide with the registry', () => {
    const id = actionEntryId({ kind: 'export', plugin: 'com.a', id: 'org' })
    expect(id).toBe('plugin:export:com.a/org')
    expect(actionOfEntry(id)).toEqual({ kind: 'export', plugin: 'com.a', id: 'org' })
    expect(actionOfEntry('note.new')).toBeUndefined()
    expect(actionOfEntry('plugin:delete:com.a/x')).toBeUndefined()
  })

  it('gives keys only when free and well formed, the first plugin winning', () => {
    const taken = (key: string) => key === 'Mod+N' || key === 'Mod+Q'
    const { keys, dropped } = pluginKeys(
      [
        plugin('com.b', { keys: ['Mod+Shift+U'] }),
        plugin('com.a', {
          keys: ['Mod+Shift+U', 'Mod+N', 'Mod+Q', 'Shift+Alt+X', 'Shift+Mod+Y', 'Ctrl+Alt+J'],
        }),
      ],
      taken,
    )
    expect(keys).toEqual([
      { key: 'Mod+Shift+U', plugin: 'com.a', command: 'c0' },
      { key: 'Ctrl+Alt+J', plugin: 'com.a', command: 'c5' },
    ])
    expect(dropped).toEqual([
      { plugin: 'com.a', command: 'c1' },
      { plugin: 'com.a', command: 'c2' },
      { plugin: 'com.a', command: 'c3' },
      { plugin: 'com.a', command: 'c4' },
      { plugin: 'com.b', command: 'c0' },
    ])
  })

  it('gives no keys without the keymaps permission', () => {
    expect(pluginKeys([plugin('com.a', { granted: ['commands'] })], () => false).keys).toEqual([])
  })

  it('draws a language with one renderer, the first plugin by ID', () => {
    expect(
      rendererSpecs([
        plugin('com.b'),
        plugin('com.a'),
        plugin('com.c', { language: 'csv' }),
        plugin('com.d', { language: 'tsv', granted: ['commands'] }),
      ]),
    ).toEqual([
      { key: 'com.a/r', language: 'chart' },
      { key: 'com.c/r', language: 'csv' },
    ])
    expect(rendererOfKey('com.a/r')).toEqual({ plugin: 'com.a', renderer: 'r' })
  })
})

describe('stopsImport', () => {
  it('stops on a plugin that timed out or stopped, not on one file it could not convert', () => {
    expect(stopsImport(new Error('E_PLUGIN_TIMEOUT'))).toBe(true)
    expect(stopsImport(new Error('E_PLUGIN_STOPPED'))).toBe(true)
    expect(stopsImport(new Error('E_PLUGIN_FAILED'))).toBe(false)
    expect(stopsImport('odd')).toBe(false)
  })
})
