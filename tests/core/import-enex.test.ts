import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  type ImportOptions,
} from '../../src/core'
import { importConverted } from '../../src/core/plugins/import'
import { imageLinks } from '../../src/core/import'
import { parseManifest } from '../../src/core/plugins/manifest'
import { checkResult, type Converted } from '../../src/core/plugins/protocol'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const opened: SqliteAdapter[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
const sample = readFileSync(new URL('../fixtures/sample.enex', import.meta.url), 'utf8')
let convert: (file: { name: string; text: string }) => Converted[]
runInNewContext(readFileSync('plugins/enex/main.js', 'utf8'), {
  devot: {
    importer: {
      handle: (id: string, handler: typeof convert) => {
        if (id !== 'enex') throw new Error('E_TEST_IMPORT_FORMAT')
        convert = handler
      },
    },
  },
  Uint8Array,
  TextEncoder,
  atob,
  Date,
})

async function run(
  text: string,
  extra: Partial<ImportOptions> & { failTags?: boolean; converted?: Converted | Converted[] } = {},
) {
  const storage = openSqliteAdapter(join(tempDir('enex-'), 'db.sqlite'))
  opened.push(storage)
  const clock = createClock('test')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const destination = await books.create('Destination', null)
  if (extra.failTags)
    storage.db.exec(
      "CREATE TRIGGER refuse_import_tags BEFORE INSERT ON note_tags BEGIN SELECT RAISE(ABORT, 'E_TEST_TAG'); END",
    )
  const report = await importConverted({
    notes,
    books,
    tags,
    newId,
    files: storage,
    destination,
    name: 'Archive.enex',
    converted: extra.converted ?? convert({ name: 'Archive.enex', text }),
    ...extra,
  })
  return { storage, notes, books, tags, report, destination }
}

it('imports ENML, dates, tags and resources into a notebook under the destination', async () => {
  const before = Date.now()
  const { storage, notes, books, tags, report, destination } = await run(sample)
  expect(report.notes).toBe(3)
  expect(report.books).toBe(1)
  expect(report.attachments).toBe(1)
  expect(report.problems.map((p) => p.code)).toEqual(
    expect.arrayContaining(['E_IMPORT_ATTACHMENT_UNSUPPORTED', 'E_IMPORT_ENCRYPTED']),
  )
  const book = (await books.list()).find((b) => b.name === 'Archive')!
  expect(book.parentId).toBe(destination)
  const records = await Promise.all(Object.values(report.noteIds).map((id) => storage.getNote(id)))
  const first = records.find((n) => n?.title === 'Research & plans')!
  expect(report.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        image: 'paper.pdf',
        code: 'E_IMPORT_ATTACHMENT_UNSUPPORTED',
        noteId: first.id,
        noteTitle: 'Research & plans',
      }),
      expect.objectContaining({
        code: 'E_IMPORT_ENCRYPTED',
        noteId: first.id,
        noteTitle: 'Research & plans',
      }),
    ]),
  )
  expect(first.bookId).toBe(book.id)
  expect(first.bodyMd).toContain('**bold**')
  expect(first.bodyMd).toContain('[link](https://example.com)')
  expect(first.bodyMd).toContain('- [x] Done')
  expect(first.bodyMd).toMatch(/[-*] \[ \] Next/)
  expect(first.bodyMd).not.toContain('secret')
  expect(first.bodyMd).not.toContain('![]()')
  expect(first.bodyMd).not.toContain('# Research')
  expect(first.bodyMd).toMatch(/!\[.*\]\(devot:\/\/file\//)
  const stored = storage.db.prepare('SELECT id, note_id, name, mime, data FROM files').all() as {
    id: string
    note_id: string
    name: string
    mime: string
    data: Uint8Array
  }[]
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({ note_id: first.id, name: 'board.png', mime: 'image/png' })
  expect(Array.from(stored[0]!.data.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(first.bodyMd).toContain(`devot://file/${stored[0]!.id}`)
  expect(first.createdAt).toBe(Date.UTC(2023, 10, 5, 12))
  expect(first.updatedAt).toBe(Date.UTC(2023, 10, 6, 13))
  for (const tag of await tags.list())
    expect((await storage.getNoteTag(first.id, tag.id))?.present).toBe(true)
  expect((await tags.list()).map((t) => t.name).sort()).toEqual(['research & ideas', 'work'])
  const undated = records.find((n) => n?.title === 'Undated')!
  expect(undated.createdAt).toBeGreaterThanOrEqual(before)
  expect(undated.updatedAt).toBeGreaterThanOrEqual(undated.createdAt)
  const clamped = records.find((n) => n?.title === 'Earlier update')!
  expect(clamped.updatedAt).toBe(clamped.createdAt)
  await notes.flush()
})

it('reports malformed XML as a file error without partial notes or notebooks', async () => {
  await expect(run(sample.replace('</en-export>', '<note>'))).rejects.toThrow('E_IMPORT_ENEX_XML')
  expect((await opened[0]!.listBooks()).map((b) => b.name)).toEqual(['Destination'])
  expect(opened[0]!.db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 })
})

it('imports no notes from an empty export or a stopped import', async () => {
  expect((await run('<en-export/>')).report.notes).toBe(0)
  expect((await run(sample, { stopped: () => true })).report.notes).toBe(0)
})

it('appends unreferenced images and preserves Unicode text and filenames', async () => {
  const text = sample
    .replace(/<en-media[^>]*\/>/g, '')
    .replace('board.png', '\u00e9tude.png')
    .replace('Plain &amp; simple.', '&#x1f600; &amp; caf\u00e9.')
  const { report, storage } = await run(text)
  expect(report.attachments).toBe(1)
  expect(storage.db.prepare('SELECT name FROM files').get()).toEqual({ name: '\u00e9tude.png' })
  const records = await Promise.all(Object.values(report.noteIds).map((id) => storage.getNote(id)))
  expect(records.find((n) => n?.title === 'Undated')?.bodyMd).toContain('\u{1f600} & caf\u00e9')
  expect(records[0]?.bodyMd).toContain('devot://file/')
})

it('reports bad resources without losing the note and falls back from invalid dates', async () => {
  const before = Date.now()
  const { report, storage } = await run(
    sample.replace('20231105T120000Z', '20230230T120000Z').replace('iVBORw0KGgo', '!invalid!'),
  )
  expect(report.notes).toBe(3)
  expect(report.attachments).toBe(0)
  expect(report.problems.map((p) => p.code)).toContain('E_IMPORT_ATTACHMENT_INVALID')
  const first = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(first?.createdAt).toBeGreaterThanOrEqual(before)
  expect(first?.updatedAt).toBe(first?.createdAt)
})

it('cleans up a failed note and its stored attachments and removes its unused notebook', async () => {
  const text = sample.slice(0, sample.indexOf('  <note><title>Undated')) + '</en-export>'
  const { report, storage } = await run(text, { failTags: true })
  expect(report.notes).toBe(0)
  expect(report.books).toBe(0)
  expect(report.problems.map((p) => p.code)).toContain('E_TEST_TAG')
  expect(storage.db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 })
  expect(
    storage.db.prepare('SELECT count(*) AS n FROM notes WHERE purged_at IS NULL').get(),
  ).toEqual({
    n: 0,
  })
})

it('stops between notes and reports note progress', async () => {
  let done = 0
  const progress: number[][] = []
  const { report } = await run(sample, {
    stopped: () => done >= 1,
    onProgress: (count: number, total: number) => {
      done = count
      progress.push([count, total])
    },
  })
  expect(report.notes).toBe(1)
  expect(report.problems.filter((p) => p.code === 'E_IMPORT_STOPPED')).toHaveLength(2)
  expect(progress).toEqual([
    [0, 3],
    [1, 3],
  ])
})

it('does not resolve external entities or expose their contents', async () => {
  await expect(
    run(
      '<!DOCTYPE en-export [<!ENTITY external SYSTEM "file:///etc/passwd">]><en-export><note><title>&external;</title></note></en-export>',
    ),
  ).rejects.toThrow('E_IMPORT_ENEX_XML')
})

it('ships a valid API 3 plugin and converts the fixture independently of the host', () => {
  const manifest = parseManifest(JSON.parse(readFileSync('plugins/enex/devot-plugin.json', 'utf8')))
  expect(manifest.apiVersion).toBe(3)
  expect(manifest.permissions).toEqual(['import'])
  expect(manifest.contributes.importFormats[0]?.maxFileBytes).toBe(100 * 1024 * 1024)
  const notes = convert({ name: 'Archive.enex', text: sample })
  expect(checkResult('import.convert', notes, 3)).toHaveLength(3)
  expect(notes[0]).toMatchObject({
    title: 'Research & plans',
    tags: ['work', 'research & ideas'],
    createdAt: Date.UTC(2023, 10, 5, 12),
    updatedAt: Date.UTC(2023, 10, 6, 13),
  })
  expect(notes[0]?.html).toContain('attachment:0')
  expect(notes[0]?.attachments?.map((a) => a.name)).toEqual(['board.png', 'paper.pdf'])
})

it('bounds long resource filenames while preserving their extension', async () => {
  const name = 'a'.repeat(230) + '.png'
  const { report, storage } = await run(sample.replace('board.png', name))
  expect(report.notes).toBe(3)
  expect(report.attachments).toBe(1)
  expect(storage.db.prepare('SELECT name FROM files').get()).toEqual({
    name: 'a'.repeat(196) + '.png',
  })
})

it('refuses malformed ENML before writing any notes', async () => {
  await expect(run(sample.replace('<en-note>Last</en-note>', '<en-note>Last'))).rejects.toThrow(
    'E_IMPORT_ENEX_XML',
  )
})

it('converts tasks already in lists and XHTML entities without rewriting ordinary marker-like text', async () => {
  const { report, storage } = await run(
    '<en-export><note><title>Tasks</title><content><![CDATA[<en-note><ul><li><en-todo checked="true"/>Done</li><li><en-todo/>Next</li></ul><div>&copy; &nbsp; DEVOTENEXCHECKED text</div><div>A<br/>B</div></en-note>]]></content></note></en-export>',
  )
  const note = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(note?.bodyMd).toContain('- [x] Done')
  expect(note?.bodyMd).toContain('- [ ] Next')
  expect(note?.bodyMd).not.toContain('- - [')
  expect(note?.bodyMd).toContain('\u00a9')
  expect(note?.bodyMd).toContain('DEVOTENEXCHECKED text')
  expect(note?.bodyMd).toContain('A\\\nB')
})

it('refuses images above the existing attachment size limit', async () => {
  const encoded = btoa('\x89PNG\r\n\x1a\n' + 'x'.repeat(10 * 1024 * 1024))
  const { report } = await run(
    `<en-export><note><title>Large</title><content><![CDATA[<en-note>Text</en-note>]]></content><resource><data>${encoded}</data><mime>image/png</mime></resource></note></en-export>`,
  )
  expect(report.notes).toBe(1)
  expect(report.attachments).toBe(0)
  expect(report.problems).toEqual([
    {
      path: 'Archive/1.md',
      code: 'E_FILE_SIZE_INVALID',
      noteId: report.noteIds['Archive/1.md'],
      noteTitle: 'Large',
    },
  ])
})

it('rewrites only HTML image destinations, not attachment-like text or link URLs', async () => {
  const attachment = convert({ name: 'a.enex', text: sample })[0]!.attachments![0]!
  const { report, storage } = await run('', {
    converted: {
      title: 'Literal',
      html: '<p>attachment:0</p><a href="https://example.com/attachment:0">Link</a><img src="attachment:0">',
      attachments: [attachment],
    },
  })
  const note = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(note?.bodyMd).toContain('attachment:0')
  expect(note?.bodyMd).toContain('[Link](https://example.com/attachment:0)')
  expect(note?.bodyMd).toContain('devot://file/')
  expect(note?.bodyMd).not.toContain('devot.invalid')
})

it('removes rejected reference images and unused definitions, preserving ordinary links', async () => {
  const { report, storage } = await run('', {
    converted: {
      title: 'References',
      markdown:
        '![PDF][bad]\n![bad]\n![PDF][]\n![missing][absent]\n\n[bad]: attachment:0\n[PDF]: attachment:0\n[absent]: attachment:1\n\n[Keep][good]\n\n[good]: https://example.com',
      attachments: [{ name: 'paper.pdf', mime: 'application/pdf', data: btoa('PDF') }],
    },
  })
  const note = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(report.notes).toBe(1)
  expect(note?.bodyMd).not.toContain('![')
  expect(note?.bodyMd).not.toContain('attachment:')
  expect(note?.bodyMd).toContain('[Keep][good]')
  expect(note?.bodyMd).toContain('[good]: https://example.com')
})

it.each([
  ['https://example.com/image.png', 'attachment:1', 'https://example.com/image.png'],
  ['attachment:0', 'attachment:1', 'devot://file/'],
  ['attachment:1', 'https://example.com/image.png', null],
])(
  'resolves duplicate image definitions using the first URL: %s',
  async (first, second, expected) => {
    const image = convert({ name: 'a.enex', text: sample })[0]!.attachments![0]!
    const { report, storage } = await run('', {
      converted: {
        title: 'Duplicates',
        markdown: `![image][same]\n\n[same]: ${first}\n[same]: ${second}`,
        attachments: [image, { name: 'paper.pdf', mime: 'application/pdf', data: btoa('PDF') }],
      },
    })
    const note = await storage.getNote(Object.values(report.noteIds)[0]!)
    const urls = imageLinks(note!.bodyMd).map((link) =>
      link.url.startsWith('devot://file/') ? 'devot://file/' : link.url,
    )
    expect(urls).toEqual(expected ? [expected] : [])
  },
)

it('keeps legacy single-note Markdown imports in the destination without a notebook', async () => {
  const { report, storage, destination } = await run('', {
    converted: { title: 'Legacy', markdown: '**Body**' },
  })
  expect(report.notes).toBe(1)
  expect(report.books).toBe(0)
  const note = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(note).toMatchObject({ title: 'Legacy', bodyMd: '**Body**', bookId: destination })
})

it('applies generic metadata and Markdown attachment URLs, clamping dates in the host', async () => {
  const attachment = convert({ name: 'a.enex', text: sample })[0]!.attachments![0]!
  const { report, storage, tags } = await run('', {
    converted: [
      {
        title: 'Generic',
        markdown: '![image](attachment:0)',
        tags: ['host'],
        createdAt: 100,
        updatedAt: 0,
        attachments: [attachment],
      },
    ],
  })
  const note = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(note).toMatchObject({ createdAt: 100, updatedAt: 100 })
  expect(note?.bodyMd).toContain('devot://file/')
  expect(note?.bodyMd).not.toContain('attachment:')
  expect((await tags.list()).map((t) => t.name)).toEqual(['host'])
})
