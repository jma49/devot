import { describe, expect, it, vi } from 'vitest'
import { parseManifest, type InstalledPlugin } from '../../../core/plugins'
import { importPluginFiles, readPluginFiles, routeImport } from './importFiles'

const plugin = (): InstalledPlugin => ({
  manifest: parseManifest({
    id: 'com.example.import',
    name: 'Import',
    version: '1.0.0',
    apiVersion: 1,
    main: 'main.js',
    permissions: ['import'],
    contributes: { importFormats: [{ id: 'text', title: 'Text', extensions: ['txt', 'md'] }] },
  }),
  enabled: true,
  granted: ['import'],
})

describe('plugin file imports', () => {
  it('routes built-ins before enabled, permitted plugin formats', () => {
    const installed = plugin()
    expect(routeImport('note.MD', [installed]).kind).toBe('builtin')
    expect(routeImport('note.TXT', [installed])).toEqual({
      kind: 'plugin',
      plugin: installed,
      format: 'text',
    })
    expect(routeImport('note.txt', [{ ...installed, enabled: false }]).kind).toBe('unsupported')
    expect(routeImport('note.txt', [{ ...installed, granted: [] }]).kind).toBe('unsupported')
    expect(routeImport('note.zip', [installed]).kind).toBe('unsupported')
  })

  it('captures converted notes in order, continues ordinary errors and stops a dead plugin', async () => {
    const convert = vi
      .fn<(...args: unknown[]) => Promise<{ title: string; markdown: string }>>()
      .mockResolvedValueOnce({ title: 'Converted', markdown: 'body' })
      .mockRejectedValueOnce(new Error('E_BAD_FILE'))
      .mockRejectedValueOnce(new Error('E_PLUGIN_STOPPED'))
    const capture = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('note-id')
    const failed = vi.fn<(error: unknown) => void>()
    expect(
      await importPluginFiles(
        plugin(),
        'text',
        ['one', 'bad', 'dead', 'unreached'].map((name) => ({ name, text: name })),
        { convertImport: convert },
        { capture },
        'book-id',
        () => true,
        failed,
      ),
    ).toEqual(['note-id'])
    expect(capture).toHaveBeenCalledExactlyOnceWith('Converted', 'body', 'book-id')
    expect(failed).toHaveBeenCalledTimes(2)
    expect(convert).toHaveBeenCalledTimes(3)
  })

  it('validates the whole batch, permission, format, UTF-8 and write gate before capture', async () => {
    const host = {
      convertImport: vi
        .fn<() => Promise<{ title: string; markdown: string }>>()
        .mockResolvedValue({ title: 'note', markdown: 'body' }),
    }
    const core = { capture: vi.fn<() => Promise<string>>().mockResolvedValue('id') }
    const run = (files: { name: string; text: string }[], allowed = true) =>
      importPluginFiles(
        plugin(),
        'text',
        files,
        host,
        core,
        null,
        () => allowed,
        () => {},
      )
    expect(await run([])).toEqual([])
    await expect(run(Array.from({ length: 21 }, () => ({ name: 'n', text: '' })))).rejects.toThrow(
      'E_PLUGIN_IMPORT_TOO_MANY',
    )
    await expect(run([{ name: 'n', text: 'x'.repeat(5 * 1024 * 1024 + 1) }])).rejects.toThrow(
      'E_PLUGIN_IMPORT_TOO_LARGE',
    )
    await expect(run([{ name: 'n', text: '\u00e9'.repeat(3 * 1024 * 1024) }])).rejects.toThrow(
      'E_PLUGIN_IMPORT_TOO_LARGE',
    )
    await expect(run([{ name: 'n', text: '\ud800' }])).rejects.toThrow('E_PLUGIN_IMPORT_NOT_TEXT')
    await expect(run([{ name: 'n', text: '' }], false)).rejects.toThrow('E_LICENCE_REQUIRED')
    await expect(
      importPluginFiles(
        { ...plugin(), granted: [] },
        'text',
        [],
        host,
        core,
        null,
        () => true,
        () => {},
      ),
    ).rejects.toThrow('E_PLUGIN_PERMISSION_DENIED')
    await expect(
      importPluginFiles(
        plugin(),
        'missing',
        [],
        host,
        core,
        null,
        () => true,
        () => {},
      ),
    ).rejects.toThrow('E_PLUGIN_FORMAT_UNKNOWN')
    await expect(readPluginFiles([new File([new Uint8Array([255])], 'bad.txt')])).rejects.toThrow(
      'E_PLUGIN_IMPORT_NOT_TEXT',
    )
    expect(core.capture).not.toHaveBeenCalled()
    expect(await readPluginFiles([new File(['\ufeffvalid'], 'note.txt')])).toEqual([
      { name: 'note.txt', text: '\ufeffvalid' },
    ])
  })
})
