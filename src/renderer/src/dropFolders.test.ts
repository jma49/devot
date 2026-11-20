import { describe, expect, it, vi } from 'vitest'
import { droppedFolders, type DropEntry } from './dropFolders'
import { MAX_FILE_BYTES } from '../../core/files'

const leaf = (name: string, text = '# Note', size?: number): DropEntry => ({
  name,
  isDirectory: false,
  isFile: true,
  file: (done) => {
    const file = new File([text], name)
    if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
    done(file)
  },
})
const folder = (name: string, children: DropEntry[]): DropEntry => ({
  name,
  isDirectory: true,
  isFile: false,
  createReader: () => {
    let at = 0
    return { readEntries: (done) => done(children.slice(at, ++at)) }
  },
})

describe('directory drops', () => {
  it('handles empty folders, invalid roots, Unicode paths and shared count/depth limits', async () => {
    expect((await droppedFolders([folder('Empty', [])], vi.fn())).scan.files).toEqual([])
    await expect(droppedFolders([], vi.fn())).rejects.toThrow('E_IMPORT_ROOT_INVALID')
    await expect(droppedFolders([leaf('note.md')], vi.fn())).rejects.toThrow(
      'E_IMPORT_ROOT_INVALID',
    )
    const roots = [
      folder('Root', [leaf('e\u0301.md'), folder('Deep', [leaf('child.md')]), leaf('img.png')]),
    ]
    const limited = await droppedFolders(roots, vi.fn(), { files: 1, entries: 10, depth: 0 })
    expect(limited.scan.files[0]?.path).toBe('e\u0301.md')
    expect(limited.scan.skipped).toEqual([{ path: 'Deep', code: 'E_IMPORT_TOO_DEEP' }])
    await expect(
      droppedFolders(roots, vi.fn(), { files: 1, entries: 10, depth: 1 }),
    ).rejects.toThrow('E_IMPORT_TOO_MANY_FILES')
    await expect(
      droppedFolders(roots, vi.fn(), { files: 10, entries: 1, depth: 1 }),
    ).rejects.toThrow('E_IMPORT_FOLDER_TOO_LARGE')
  })

  it('keeps vault defaults for unsafe, oversized or missing settings and reports unreadable files', async () => {
    for (const config of [
      [],
      [
        leaf(
          'app.json',
          '{"attachmentFolderPath":"../secret","newLinkFormat":"other","useMarkdownLinks":"yes"}',
        ),
      ],
      [leaf('app.json', '{}', 65_537)],
    ]) {
      const result = await droppedFolders(
        [
          folder('Vault', [
            folder('.obsidian', config),
            { name: 'bad.md', isFile: true, isDirectory: false, file: (_, fail) => fail() },
          ]),
        ],
        vi.fn(),
      )
      expect(result.scan.vault).toEqual([
        { root: '', attachmentFolderPath: '', newLinkFormat: 'shortest', useMarkdownLinks: false },
      ])
      expect(result.scan.skipped).toEqual([{ path: 'bad.md', code: 'E_IMPORT_UNREADABLE' }])
    }
  })

  it('reads every batch and matches one-folder Rust paths, ignoring hidden and unrelated entries', async () => {
    const result = await droppedFolders(
      [
        folder('Root', [
          leaf('top.md'),
          folder('Nested', [leaf('child.md')]),
          leaf('.hidden.md'),
          folder('.cache', [leaf('secret.md')]),
          leaf('page.html'),
          leaf('huge.md', '', MAX_FILE_BYTES + 1),
          leaf('photo.png'),
        ]),
      ],
      vi.fn(),
    )
    expect(result.scan.kind).toBe('folder')
    expect(result.scan.name).toBe('Root')
    expect(result.scan.files.map((f) => f.path)).toEqual(['Nested/child.md', 'top.md'])
    expect(result.scan.images.map((f) => f.path)).toEqual(['photo.png'])
    expect(result.scan.skipped).toEqual([{ path: 'huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }])
    expect(await result.source.read('Nested/child.md')).toBe('# Note')
    await result.cleanup()
    await expect(result.source.read('top.md')).rejects.toThrow('E_IMPORT_FILE_NOT_FOUND')
  })

  it('prefixes several roots with unique case-insensitive names and detects vault defaults', async () => {
    const result = await droppedFolders(
      [
        folder('Vault', [
          folder('.obsidian', [
            leaf(
              'app.json',
              '{"attachmentFolderPath":"Images","newLinkFormat":"relative","useMarkdownLinks":true}',
            ),
          ]),
          leaf('board.canvas', '{}'),
        ]),
        folder('vault', [folder('.obsidian', [leaf('app.json', 'broken')]), leaf('note.md')]),
      ],
      vi.fn(),
    )
    expect(result.scan.kind).toBe('folders')
    expect(result.scan.files.map((f) => f.path)).toEqual(['Vault/board.canvas', 'vault 2/note.md'])
    expect(result.scan.vault).toEqual([
      {
        root: 'Vault',
        attachmentFolderPath: 'Images',
        newLinkFormat: 'relative',
        useMarkdownLinks: true,
      },
      {
        root: 'vault 2',
        attachmentFolderPath: '',
        newLinkFormat: 'shortest',
        useMarkdownLinks: false,
      },
    ])
  })

  it('reports unreadable directories and ignores canvas outside a vault', async () => {
    const result = await droppedFolders(
      [
        folder('Root', [
          leaf('board.canvas'),
          {
            name: 'bad',
            isFile: false,
            isDirectory: true,
            createReader: () => ({ readEntries: (_, fail) => fail() }),
          },
        ]),
      ],
      vi.fn(),
    )
    expect(result.scan.files).toEqual([])
    expect(result.scan.skipped).toEqual([{ path: 'bad', code: 'E_IMPORT_UNREADABLE' }])
  })
})
