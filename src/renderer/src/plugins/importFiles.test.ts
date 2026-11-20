import { describe, expect, it, vi } from 'vitest'
import { parseManifest, type InstalledPlugin } from '../../../core/plugins'
import type { ImportReport } from '../../../core/import'
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

const report = (noteIds: Record<string, string> = { '1.md': 'note-id' }): ImportReport => ({
  bookId: null,
  notes: Object.keys(noteIds).length,
  noteIds,
  books: 0,
  attachments: 0,
  links: 0,
  unresolvedLinks: 0,
  problems: [],
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
    const importConverted = vi
      .fn<(...args: unknown[]) => Promise<ImportReport>>()
      .mockResolvedValue(report())
    expect(
      await importPluginFiles(
        plugin(),
        'text',
        ['one', 'bad', 'dead', 'unreached'].map((name) => ({ name, text: name })),
        { convertImport: convert },
        { importConverted },
        'book-id',
        () => true,
      ),
    ).toMatchObject({ ids: ['note-id'], made: 1, error: new Error('E_PLUGIN_STOPPED') })
    expect(importConverted).toHaveBeenCalledExactlyOnceWith(
      'one',
      { title: 'Converted', markdown: 'body' },
      'book-id',
    )
    expect(convert).toHaveBeenCalledTimes(3)
  })

  it('validates the whole batch, permission, format, UTF-8 and write gate before capture', async () => {
    const host = {
      convertImport: vi
        .fn<() => Promise<{ title: string; markdown: string }>>()
        .mockResolvedValue({ title: 'note', markdown: 'body' }),
    }
    const core = {
      importConverted: vi.fn<() => Promise<ImportReport>>().mockResolvedValue(report()),
    }
    const run = (files: { name: string; text: string }[], allowed = true) =>
      importPluginFiles(plugin(), 'text', files, host, core, null, () => allowed)
    expect(await run([])).toMatchObject({ ids: [], made: 0, problems: [], error: undefined })
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
      importPluginFiles({ ...plugin(), granted: [] }, 'text', [], host, core, null, () => true),
    ).rejects.toThrow('E_PLUGIN_PERMISSION_DENIED')
    await expect(
      importPluginFiles(plugin(), 'missing', [], host, core, null, () => true),
    ).rejects.toThrow('E_PLUGIN_FORMAT_UNKNOWN')
    await expect(readPluginFiles([new File([new Uint8Array([255])], 'bad.txt')])).rejects.toThrow(
      'E_PLUGIN_IMPORT_NOT_TEXT',
    )
    expect(core.importConverted).not.toHaveBeenCalled()
    expect(await readPluginFiles([new File(['\ufeffvalid'], 'note.txt')])).toEqual([
      { name: 'note.txt', text: '\ufeffvalid' },
    ])
  })

  it('uses API 3 format limits and imports rich arrays through the same batch pipeline as the picker', async () => {
    const installed = plugin()
    installed.manifest = parseManifest({
      ...installed.manifest,
      apiVersion: 3,
      minAppVersion: '1.0.0',
      contributes: {
        ...installed.manifest.contributes,
        importFormats: [
          { id: 'text', title: 'Text', extensions: ['txt'], maxFileBytes: 6 * 1024 * 1024 },
        ],
      },
    })
    const text = 'x'.repeat(5 * 1024 * 1024 + 1)
    const files = [new File([text], 'batch.txt')]
    await expect(readPluginFiles(files)).rejects.toThrow('E_PLUGIN_IMPORT_TOO_LARGE')
    const input = await readPluginFiles(files, 6 * 1024 * 1024)
    const converted = [
      {
        title: 'First',
        html: '<p>Body</p>',
        tags: ['tag'],
        createdAt: 123,
        attachments: [{ name: 'photo.png', mime: 'image/png', data: 'iVBORw0KGgo=' }],
      },
      { title: 'Second', markdown: 'body', updatedAt: 456 },
    ]
    const convertImport = vi.fn<() => Promise<typeof converted>>().mockResolvedValue(converted)
    const importConverted = vi.fn<() => Promise<ImportReport>>().mockResolvedValue({
      ...report({ '1.md': 'first', '2.md': 'second' }),
      attachments: 1,
      problems: [{ path: '1.md', code: 'W_PLUGIN_IMPORT_SKIPPED' }],
    })
    const result = await importPluginFiles(
      installed,
      'text',
      input,
      { convertImport },
      { importConverted },
      'book',
      () => true,
    )
    expect(importConverted).toHaveBeenCalledExactlyOnceWith('batch.txt', converted, 'book')
    expect(result).toMatchObject({
      ids: ['first', 'second'],
      made: 2,
      error: undefined,
      problems: [{ code: 'W_PLUGIN_IMPORT_SKIPPED' }],
    })
    await expect(
      importPluginFiles(
        installed,
        'text',
        [{ name: 'bad', text: 'x'.repeat(6 * 1024 * 1024 + 1) }],
        { convertImport },
        { importConverted },
        null,
        () => true,
      ),
    ).rejects.toThrow('E_PLUGIN_IMPORT_TOO_LARGE')
  })
})
