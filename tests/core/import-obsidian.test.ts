import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  importMarkdown,
  importLayout,
  noteUri,
  prepareImportFile,
  type ImportScan,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'
import { filesUnder } from '../support/files-under'

const fixture = join(__dirname, 'fixtures', 'obsidian-vault')
const opened: SqliteAdapter[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))

async function run(
  files?: Record<string, string>,
  images?: string[],
  attachmentFolderPath = 'Attachments',
  conventions?: boolean,
) {
  const db = openSqliteAdapter(join(tempDir('devot-obsidian-'), 'db.sqlite'))
  opened.push(db)
  const paths = files ? Object.keys(files) : filesUnder(fixture).filter((p) => !p.startsWith('.'))
  const newId = createIdGenerator()
  const clock = createClock('test')
  const scan: ImportScan = {
    id: 1,
    name: 'Vault',
    kind: 'folder',
    vault: [{ root: '', attachmentFolderPath, newLinkFormat: 'shortest', useMarkdownLinks: false }],
    files: paths.filter((p) => /\.(md|canvas)$/.test(p)).map((path) => ({ path, bytes: 1 })),
    images: (images ?? paths.filter((p) => p.endsWith('.png'))).map((path) => ({ path, bytes: 1 })),
    skipped: [],
  }
  const attached: string[] = []
  const report = await importMarkdown({
    notes: createNoteService({ storage: db, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage: db, clock, newId }),
    tags: createTagService({ storage: db, clock, newId }),
    newId,
    scan,
    ...(conventions === undefined ? {} : { conventions }),
    source: {
      read: async (path) => (files ? files[path]! : readFileSync(join(fixture, path), 'utf8')),
      attach: async (path, file) => {
        attached.push(path)
        const data = readFileSync(join(fixture, files ? 'Attachments/only-settings.png' : path))
        await db.putFile({ ...file, name: path.split('/').pop()! }, new Uint8Array(data))
      },
    },
  })
  const note = async (path: string) => (await db.getNote(report.noteIds[path]!))!
  return { db, scan, report, attached, note }
}

describe('Obsidian vault import', () => {
  it('uses metadata rather than a path to identify a vault', () => {
    expect(
      importLayout(
        'folder',
        [{ path: 'Note.md', bytes: 1 }],
        [
          {
            root: '',
            attachmentFolderPath: '',
            newLinkFormat: 'shortest',
            useMarkdownLinks: false,
          },
        ],
      ).app,
    ).toBe('obsidian')
    expect(importLayout('folder', [{ path: '.obsidian/Note.md', bytes: 1 }]).app).toBeNull()
  })

  it('imports a sample vault with properties, conventions, links, attachments and canvas', async () => {
    const { db, report, attached, note } = await run()
    expect(report.notes).toBe(3)
    expect(report.problems).toEqual([{ path: 'Invalid.canvas', code: 'E_IMPORT_CANVAS_INVALID' }])
    expect(report.unresolvedLinks).toBe(0)
    const start = await note('Projects/Start.md')
    const target = report.noteIds['Projects/Note.md']!
    const original = readFileSync(join(fixture, 'Projects/Start.md'), 'utf8')
    expect(start.bodyMd.split('\n# Start')[0]).toBe(original.split('\n# Start')[0])
    for (const shown of [
      'Note',
      'alias',
      'Note#Heading',
      'Note#^block',
      'Projects/Note',
      'Other name',
    ]) {
      const label = shown === 'Projects/Note' ? 'Note' : shown
      expect(start.bodyMd).toContain(`[${label}](${noteUri(target)})`)
    }
    expect(start.bodyMd).not.toContain('![[Note]]')
    expect(start.bodyMd).toContain(
      `[Board.canvas](${noteUri(report.noteIds['Projects/Board.canvas']!)})`,
    )
    expect(start.bodyMd).toContain('> [!TIP]')
    expect((await db.listTags()).map((tag) => tag.name).sort()).toEqual(['project', 'work'])
    expect((await db.listBooks()).find((book) => book.id === start.bookId)?.name).toBe('Projects')
    expect(attached.sort()).toEqual([
      'Attachments/only-settings.png',
      'Attachments/only-settings.png',
      'Elsewhere/shortest.png',
    ])
    const canvas = await note('Projects/Board.canvas')
    expect(canvas.title).toBe('Board')
    expect(canvas.bodyMd).toContain('## Ideas\n\nCanvas **text**')
    expect(canvas.bodyMd).toContain(`[Note](${noteUri(target)})`)
    expect(canvas.bodyMd).toContain('devot://file/')
    expect(canvas.bodyMd).toContain('- Canvas **text** → Projects/Note.md: explains')
  })

  it.each(['', '/', './media', 'Attachments'])(
    'resolves the configured attachment folder %s before shortest names',
    async (setting) => {
      const configured =
        setting === './media'
          ? 'Work/media/p.png'
          : setting === 'Attachments'
            ? 'Attachments/p.png'
            : 'p.png'
      const { attached } = await run(
        { 'Work/N.md': '![](p.png) ![[p.png]]' },
        [configured, 'Work/else/p.png'],
        setting,
      )
      expect(attached).toEqual([configured])
    },
  )

  it('prefers note-relative images then root images and uses nearest fallback', async () => {
    const { attached } = await run({ 'Work/Deep/N.md': '![](p.png) ![[r.png]] ![](s.png)' }, [
      'Work/Deep/p.png',
      'p.png',
      'Attachments/p.png',
      'r.png',
      'Attachments/r.png',
      'Work/s.png',
      'Elsewhere/s.png',
    ])
    expect(attached).toEqual(['Work/Deep/p.png', 'Work/s.png', 'r.png'])
  })

  it('keeps all properties with conventions disabled too', () => {
    const source = readFileSync(join(fixture, 'Projects/Start.md'), 'utf8')
    expect(prepareImportFile(source, 'Start.md', undefined, false, true).text).toBe(source)
  })

  it('keeps an explicitly rooted image at the vault root', async () => {
    const { attached } = await run({ 'Work/N.md': '![[/p.png]] ![](/p.png)' }, [
      'p.png',
      'Work/p.png',
    ])
    expect(attached).toEqual(['p.png'])
  })

  it('decodes shortest Markdown image names and resolves folder-qualified canvas links', async () => {
    const { attached, report, note } = await run(
      {
        'N.md': '![](my%20image.png#half) [[Second/Board.canvas]]',
        'First/Board.canvas': '{"nodes":[],"edges":[]}',
        'Second/Board.canvas': '{"nodes":[],"edges":[]}',
      },
      ['Elsewhere/my image.png'],
    )
    expect(attached).toEqual(['Elsewhere/my image.png'])
    expect((await note('N.md')).bodyMd).toContain(
      `[Board.canvas](${noteUri(report.noteIds['Second/Board.canvas']!)})`,
    )
    expect((await note('N.md')).bodyMd).toContain('#half')
  })

  it('handles an empty vault and leaves a missing embed unresolved', async () => {
    expect((await run({})).report.notes).toBe(0)
    const { report, note } = await run({ 'N.md': '![[missing.png]] [[Missing]]' })
    expect(report.unresolvedLinks).toBe(2)
    expect((await note('N.md')).bodyMd).toBe('![[missing.png]] [[Missing]]')
  })
})
