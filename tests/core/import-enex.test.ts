import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  importMarkdown,
  type ImportOptions,
  type ImportScan,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const opened: SqliteAdapter[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
const sample = readFileSync(new URL('../fixtures/sample.enex', import.meta.url), 'utf8')

async function run(text: string, extra: Partial<ImportOptions> = {}) {
  const storage = openSqliteAdapter(join(tempDir('enex-'), 'db.sqlite'))
  opened.push(storage)
  const clock = createClock('test')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const destination = await books.create('Destination', null)
  const scan: ImportScan = {
    id: 1,
    name: 'Archive',
    kind: 'enex',
    files: [{ path: 'Archive.enex', bytes: text.length }],
    images: [],
    skipped: [],
  }
  const report = await importMarkdown({
    notes,
    books,
    tags,
    newId,
    files: storage,
    destination,
    scan,
    source: {
      read: async () => text,
      attach: async () => {
        throw new Error('E_TEST_UNEXPECTED')
      },
    },
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
    expect.arrayContaining(['E_IMPORT_ENEX_RESOURCE_UNSUPPORTED', 'E_IMPORT_ENEX_ENCRYPTED']),
  )
  const book = (await books.list()).find((b) => b.name === 'Archive')!
  expect(book.parentId).toBe(destination)
  const records = await Promise.all(Object.values(report.noteIds).map((id) => storage.getNote(id)))
  const first = records.find((n) => n?.title === 'Research & plans')!
  expect(first.bookId).toBe(book.id)
  expect(first.bodyMd).toContain('**bold**')
  expect(first.bodyMd).toContain('[link](https://example.com)')
  expect(first.bodyMd).toContain('- [x] Done')
  expect(first.bodyMd).toContain('- [ ] Next')
  expect(first.bodyMd).not.toContain('secret')
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
  const { report, books } = await run(sample.replace('</en-export>', '<note>'))
  expect(report.notes).toBe(0)
  expect(report.books).toBe(0)
  expect(report.problems).toEqual([{ path: 'Archive.enex', code: 'E_IMPORT_ENEX_XML' }])
  expect((await books.list()).map((b) => b.name)).toEqual(['Destination'])
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
  expect(report.problems.map((p) => p.code)).toContain('E_IMPORT_ENEX_RESOURCE_INVALID')
  const first = await storage.getNote(Object.values(report.noteIds)[0]!)
  expect(first?.createdAt).toBeGreaterThanOrEqual(before)
  expect(first?.updatedAt).toBe(first?.createdAt)
})

it('cleans up a failed note and its stored attachments and removes its unused notebook', async () => {
  const text = sample.slice(0, sample.indexOf('  <note><title>Undated')) + '</en-export>'
  const { report, storage } = await run(text.replace('<tag>work</tag>', '<tag>bad&#10;tag</tag>'))
  expect(report.notes).toBe(0)
  expect(report.books).toBe(0)
  expect(report.problems.map((p) => p.code)).toContain('E_TAG_NAME_INVALID')
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
  const { report } = await run(
    '<!DOCTYPE en-export [<!ENTITY external SYSTEM "file:///etc/passwd">]><en-export><note><title>&external;</title></note></en-export>',
  )
  expect(report.notes).toBe(0)
  expect(report.problems).toEqual([{ path: 'Archive.enex', code: 'E_IMPORT_ENEX_XML' }])
})

it('imports multiple exports with distinct notebooks, including identical filenames', async () => {
  const { report, books } = await run(sample, {
    scan: {
      id: 1,
      name: 'Exports',
      kind: 'enex',
      files: [
        { path: 'one/Archive.enex', bytes: 1 },
        { path: 'two/Archive.enex', bytes: 1 },
      ],
      images: [],
      skipped: [],
    },
  })
  expect(report.notes).toBe(6)
  expect(report.books).toBe(2)
  expect((await books.list()).map((b) => b.name).sort()).toEqual([
    'Archive',
    'Archive (2)',
    'Destination',
  ])
})

it('keeps valid notes when another note has malformed ENML', async () => {
  const { report } = await run(sample.replace('<en-note>Last</en-note>', '<en-note>Last'))
  expect(report.notes).toBe(2)
  expect(report.problems).toContainEqual({ path: 'Archive/3.md', code: 'E_IMPORT_ENEX_XML' })
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
  expect(report.problems).toEqual([{ path: 'Archive/1.md', code: 'E_FILE_SIZE_INVALID' }])
})
