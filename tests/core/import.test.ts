import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  buildBookTree,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  EXPORT_HEADER,
  imageLinks,
  importMarkdown,
  importTree,
  lineFeeds,
  replaceRanges,
  resolveImagePath,
  type BookNode,
  type ImportFolder,
  type ImportScan,
  type ImportSource,
  type NoteRecord,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 2])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
const CJK = '\u4e2d\u6587\u7b14\u8bb0'

/** A sample folder covering the Markdown dialect Devot supports. */
const SAMPLE: Record<string, string> = {
  'Inbox.md': '# Inbox\n\nLoose thoughts with a [[Wiki Link]] and [[Plan|alias]].\n',
  'Projects/Plan.md': [
    '---',
    'title: Launch plan',
    'tags: [work, "q4 goals", "#later"]',
    'status: On Hold',
    'author: someone',
    'aliases:',
    '  - plan',
    '---',
    '# Plan heading',
    '',
    '![Board](img/board.png "The board") and again ![same](./img/board.png).',
    '',
    '![Logo][logo]',
    '',
    '[logo]: /assets/logo.jpg',
    '',
    '- [ ] task one',
    '- [x] task two',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'Footnote[^1] and ~~strike~~ and :tada: and `#ff8800`.',
    '',
    '[^1]: The note.',
    '',
  ].join('\n'),
  'Projects/Deep/Spec.md': [
    '---',
    'tags:',
    '  - work',
    '  - spec',
    'status: completed',
    '---',
    '',
    `Text in ${CJK} stays.`,
    '',
    '> [!NOTE]',
    '> An alert.',
    '',
    'Math $e^{i\\pi}+1=0$ and',
    '',
    '$$',
    '\\int_0^1 x\\,dx',
    '$$',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    '```md',
    '![not an image](img/in-fence.png)',
    '```',
    '',
    '![Remote](https://example.com/r.png) ![Missing](missing.png) ![Up](../../../outside.png)',
    '![Vector](../../assets/icon.svg) ![Shot](<../../assets/my shot.jpg>)',
    '',
    '<details><summary>More</summary>Raw HTML stays.</details>',
    '',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '',
    'Trailing spaces  ',
    'and CRLF\r\nline\r\n',
  ].join('\n'),
  'Archive/Old/Ancient.md': 'Plain text, no heading.\n',
}

const TITLES: Record<string, string> = {
  'Inbox.md': 'Inbox',
  'Projects/Plan.md': 'Plan heading',
  'Projects/Deep/Spec.md': 'Spec',
  'Archive/Old/Ancient.md': 'Ancient',
}

const IMAGES: Record<string, Uint8Array> = {
  'Projects/img/board.png': PNG,
  'assets/logo.jpg': JPEG,
  'assets/icon.svg': SVG,
  'assets/my shot.jpg': JPEG,
  'assets/unused.png': PNG,
}

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

/** Storage that checks every note write: the snapshot must be the Yjs text. */
function checked(storage: StorageAdapter, writes: NoteRecord[]): StorageAdapter {
  return {
    ...storage,
    putNote: async (note) => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, note.ydoc)
      if (doc.getText(BODY).toString() !== note.bodyMd) throw new Error('E_TEST_SNAPSHOT_WRITTEN')
      writes.push(note)
      return storage.putNote(note)
    },
  }
}

async function setup() {
  const sqlite = openSqliteAdapter(join(tempDir('devot-import-'), 'db.sqlite'))
  open.push(sqlite)
  const writes: NoteRecord[] = []
  const storage = checked(sqlite, writes)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const services = {
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
    newId,
  }
  // Most tests import into a notebook picked as the destination.
  const vault = await services.books.create('Vault', null)
  return { sqlite, writes, services: { ...services, destination: vault }, vault }
}

/** A source over in-memory files, storing attachments like the Rust command. */
function sourceFor(sqlite: SqliteAdapter, files = SAMPLE, images = IMAGES) {
  const attached: { path: string; id: string; noteId: string }[] = []
  const source: ImportSource = {
    async read(path) {
      const text = files[path]
      if (text === undefined) throw new Error('E_IMPORT_FILE_NOT_FOUND')
      return text
    },
    async attach(path, file) {
      const bytes = images[path]
      if (!bytes) throw new Error('E_IMPORT_FILE_NOT_FOUND')
      await sqlite.putFile({ ...file, name: path.split('/').pop() ?? 'image' }, bytes)
      attached.push({ path, ...file })
    },
  }
  return { source, attached }
}

const items = (paths: string[]) => paths.sort().map((path) => ({ path, bytes: 1 }))

const scanOf = (files: Record<string, string>, extra: Partial<ImportScan> = {}): ImportScan => ({
  id: 1,
  name: 'Vault',
  kind: 'folder',
  files: items(Object.keys(files)),
  images: [],
  skipped: [],
  ...extra,
})

const names = (nodes: BookNode[]): unknown[] =>
  nodes.map((n) => (n.children.length ? [n.name, names(n.children)] : n.name))

async function noteByTitle(sqlite: SqliteAdapter, title: string) {
  const summary = (await sqlite.listNotes()).find((n) => n.title === title)
  if (!summary) throw new Error(`no note ${title}`)
  const record = await sqlite.getNote(summary.id)
  return { summary, record: record! }
}

describe('Markdown folder import', () => {
  it('puts a picked folder in the destination and makes notebooks of the folders in it', async () => {
    const { sqlite, services, vault } = await setup()
    const report = await importMarkdown({
      ...services,
      scan: scanOf(SAMPLE),
      source: sourceFor(sqlite).source,
    })
    const books = await sqlite.listBooks()
    // The picked folder is no notebook itself; folders with only images
    // (assets, img) are none either.
    expect(names(buildBookTree(books))).toEqual([
      [
        'Vault',
        [
          ['Archive', ['Old']],
          ['Projects', ['Deep']],
        ],
      ],
    ])
    expect(report.books).toBe(4)
    expect(report.notes).toBe(4)
    expect(report.bookId).toBe(vault)
    const bookOf = async (title: string) => {
      const { summary } = await noteByTitle(sqlite, title)
      return books.find((b) => b.id === summary.bookId)?.name
    }
    expect(await bookOf('Inbox')).toBe('Vault')
    expect(await bookOf('Plan heading')).toBe('Projects')
    expect(await bookOf('Spec')).toBe('Deep')
    expect(await bookOf('Ancient')).toBe('Old')
  })

  it('puts the files of a picked folder in no notebook when that is the destination', async () => {
    const { sqlite, services } = await setup()
    const files = { 'Top.md': '# Top\n', 'Sub/Inner.md': '# Inner\n' }
    const report = await importMarkdown({
      ...services,
      destination: null,
      scan: scanOf(files),
      source: sourceFor(sqlite, files).source,
    })
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual(['Vault', 'Sub'])
    expect((await noteByTitle(sqlite, 'Top')).summary.bookId).toBeNull()
    const sub = (await sqlite.listBooks()).find((b) => b.name === 'Sub')!
    expect((await noteByTitle(sqlite, 'Inner')).summary.bookId).toBe(sub.id)
    // The one top-level notebook made is the one to show.
    expect(report).toMatchObject({ books: 1, bookId: sub.id })
  })

  it('makes a notebook of each folder when several are picked', async () => {
    const { sqlite, services, vault } = await setup()
    const files = {
      'Work/Plan.md': '# Plan\n',
      'Work/Q4/Goals.md': '# Goals\n',
      'Home/List.md': '# List\n',
      'Photos/cat.png': '',
    }
    const notes = Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith('.md')))
    const report = await importMarkdown({
      ...services,
      scan: scanOf(notes, { kind: 'folders', name: 'Work', images: items(['Photos/cat.png']) }),
      source: sourceFor(sqlite, notes).source,
    })
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual([
      ['Vault', ['Home', ['Work', ['Q4']]]],
    ])
    expect(report).toMatchObject({ notes: 3, books: 3, bookId: vault })
    const work = (await sqlite.listBooks()).find((b) => b.name === 'Work')!
    expect((await noteByTitle(sqlite, 'Plan')).summary.bookId).toBe(work.id)
  })

  it('puts picked files in the destination, whatever folder they came from', async () => {
    const { sqlite, services, vault } = await setup()
    const files = { 'Docs/a.md': '# A\n', 'Other/b.md': '# B\n' }
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files, { kind: 'files' }),
      source: sourceFor(sqlite, files).source,
    })
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual(['Vault'])
    expect(report).toMatchObject({ notes: 2, books: 0, bookId: vault })
    for (const title of ['A', 'B']) {
      expect((await noteByTitle(sqlite, title)).summary.bookId).toBe(vault)
    }
  })

  it('reads nothing from foreign front matter and keeps it in the note as written', async () => {
    const { sqlite, services } = await setup()
    await importMarkdown({ ...services, scan: scanOf(SAMPLE), source: sourceFor(sqlite).source })
    expect(await sqlite.listTags()).toEqual([])
    const plan = await noteByTitle(sqlite, 'Plan heading')
    expect(plan.summary.tagIds).toEqual([])
    expect(plan.summary.status).toBe('none')
    expect(plan.record.bodyMd.startsWith('---\ntitle: Launch plan\n')).toBe(true)
    expect(plan.record.bodyMd).toContain('author: someone\naliases:\n  - plan\n---\n')
    const spec = await noteByTitle(sqlite, 'Spec')
    expect(spec.summary.status).toBe('none')
    expect(spec.record.bodyMd.startsWith('---\ntags:\n  - work\n')).toBe(true)
  })

  it("reads the title, tags and status from Devot's own front matter and leaves it out", async () => {
    const { sqlite, services } = await setup()
    const files = {
      'Exported.md': [
        '---',
        EXPORT_HEADER,
        "title: 'Launch plan'",
        "tags: ['work', '#later']",
        'status: on hold',
        '---',
        '# Heading',
        '',
      ].join('\n'),
      'Twice.md': '---\nauthor: me\ntags: [x]\n---\nBody\n',
    }
    await importMarkdown({
      ...services,
      scan: scanOf(files),
      source: sourceFor(sqlite, files).source,
    })
    const tags = new Map((await sqlite.listTags()).map((t) => [t.id, t.name]))
    const plan = await noteByTitle(sqlite, 'Launch plan')
    expect(plan.summary.tagIds.map((id) => tags.get(id)).sort()).toEqual(['#later', 'work'])
    expect(plan.summary.status).toBe('on_hold')
    expect(plan.record.bodyMd).toBe('# Heading\n')
    const twice = await noteByTitle(sqlite, 'Twice')
    expect(twice.summary.tagIds).toEqual([])
    expect([...tags.values()].sort()).toEqual(['#later', 'work'])
  })

  it('stores images an HTML page embeds and lists what it could not keep', async () => {
    const { sqlite, services } = await setup()
    const png = Buffer.from(PNG).toString('base64')
    const files = {
      'page.html':
        `<body><h1>Page</h1><p><img src="data:image/png;base64,${png}" alt="Shot"></p>` +
        '<p>Diagram <svg><text>A</text></svg> and <math display="block"><semantics><mi>x</mi>' +
        '<annotation encoding="application/x-tex">x^2</annotation></semantics></math></p></body>',
    }
    const report = await importMarkdown({
      ...services,
      files: sqlite,
      scan: scanOf(files, { kind: 'files' }),
      source: sourceFor(sqlite, files, {}).source,
    })
    expect(report).toMatchObject({ notes: 1, attachments: 1 })
    expect(report.problems).toEqual([
      { path: 'page.html', image: '<svg>', code: 'E_IMPORT_HTML_CONTENT_DROPPED' },
    ])
    const page = await noteByTitle(sqlite, 'Page')
    const stored = sqlite.db.prepare('SELECT id, note_id AS noteId, name, mime FROM files').all()
    expect(stored).toEqual([
      { id: expect.any(String), noteId: page.summary.id, name: 'image.png', mime: 'image/png' },
    ])
    const { id } = stored[0] as { id: string }
    expect(page.record.bodyMd).toBe(`# Page\n\n![Shot](devot://file/${id})\n\nDiagram and $x^2$\n`)
  })

  it('lists only the failure for a file that fails, not what it found on the way', async () => {
    const { sqlite, services } = await setup()
    const files = { 'page.html': '<h1>P</h1><svg></svg><img src="missing.png">' }
    const report = await importMarkdown({
      ...services,
      notes: { ...services.notes, setBody: () => Promise.reject(new Error('E_TEST_BODY')) },
      files: sqlite,
      scan: scanOf(files, { kind: 'files' }),
      source: sourceFor(sqlite, files, {}).source,
    })
    expect(report).toMatchObject({ notes: 0 })
    expect(report.problems).toEqual([{ path: 'page.html', code: 'E_TEST_BODY' }])
  })

  it('lists an embedded image it could not store, and leaves no link to it', async () => {
    const { sqlite, services } = await setup()
    const png = Buffer.from(PNG).toString('base64')
    const files = { 'page.html': `<h1>P</h1><img src="data:image/png;base64,${png}" alt="Shot">` }
    const refusing = { putFile: () => Promise.reject(new Error('E_FILE_SIZE_INVALID')) }
    const report = await importMarkdown({
      ...services,
      files: refusing,
      scan: scanOf(files, { kind: 'files' }),
      source: sourceFor(sqlite, files, {}).source,
    })
    expect(report).toMatchObject({ notes: 1, attachments: 0 })
    expect(report.problems).toEqual([
      { path: 'page.html', image: 'data:image/png', code: 'E_FILE_SIZE_INVALID' },
    ])
    expect((await noteByTitle(sqlite, 'P')).record.bodyMd).toBe('# P\n\n![Shot]()\n')
  })

  it('without a store for them, lists embedded images as left out', async () => {
    const { sqlite, services } = await setup()
    const png = Buffer.from(PNG).toString('base64')
    const files = { 'page.html': `<img src="data:image/png;base64,${png}">` }
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files, { kind: 'files' }),
      source: sourceFor(sqlite, files, {}).source,
    })
    expect(report.problems).toEqual([
      { path: 'page.html', image: 'data:image/png', code: 'E_IMPORT_HTML_CONTENT_DROPPED' },
    ])
  })

  it('reads a backslash in an image link as part of a file name', async () => {
    const { sqlite, services } = await setup()
    const files = { 'C\\C++ notes.md': '# C\n\n![a](shots\\one.png) ![b](shots\\two.png)\n' }
    const { source, attached } = sourceFor(sqlite, files, { 'shots\\one.png': PNG })
    const report = await importMarkdown({ ...services, scan: scanOf(files), source })
    expect(report).toMatchObject({ notes: 1, attachments: 1 })
    expect(report.problems).toEqual([
      { path: 'C\\C++ notes.md', image: 'shots\\two.png', code: 'E_IMPORT_FILE_NOT_FOUND' },
    ])
    expect((await noteByTitle(sqlite, 'C')).record.bodyMd).toBe(
      `# C\n\n![a](devot://file/${attached[0]!.id}) ![b](shots\\two.png)\n`,
    )
  })

  it('imports picked HTML files as Markdown, with their images as attachments', async () => {
    const { sqlite, services, vault } = await setup()
    const files = {
      'Saved/page.html':
        '<html><head><title>Saved page</title></head><body><h1>Head</h1>' +
        '<p>Hi <script>alert(1)</script><img src="img/board.png" alt="b"></p></body></html>',
      'Saved/bare.htm': '<p>No title here</p>',
    }
    const { source, attached } = sourceFor(sqlite, files, { 'Saved/img/board.png': PNG })
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files, { kind: 'files' }),
      source,
    })
    expect(report).toMatchObject({ notes: 2, attachments: 1, problems: [] })
    const page = await noteByTitle(sqlite, 'Saved page')
    expect(page.summary.bookId).toBe(vault)
    expect(page.record.bodyMd).toBe(`# Head\n\nHi ![b](devot://file/${attached[0]!.id})\n`)
    expect((await noteByTitle(sqlite, 'bare')).record.bodyMd).toBe('No title here\n')
  })

  it('stores local images as attachments and points their links at them', async () => {
    const { sqlite, services } = await setup()
    const { source, attached } = sourceFor(sqlite)
    const report = await importMarkdown({ ...services, scan: scanOf(SAMPLE), source })
    const plan = await noteByTitle(sqlite, 'Plan heading')
    // The same image twice in a note is one attachment.
    expect(attached.filter((a) => a.noteId === plan.summary.id).map((a) => a.path)).toEqual([
      'Projects/img/board.png',
      'assets/logo.jpg',
    ])
    const [board, logo] = attached.filter((a) => a.noteId === plan.summary.id)
    expect(plan.record.bodyMd).toContain(
      `![Board](devot://file/${board!.id} "The board") and again ![same](devot://file/${board!.id}).`,
    )
    expect(plan.record.bodyMd).toContain(`[logo]: devot://file/${logo!.id}\n`)
    const stored = sqlite.db
      .prepare('SELECT id, note_id AS noteId, name, mime, data FROM files ORDER BY name')
      .all() as { id: string; noteId: string; name: string; mime: string; data: Buffer }[]
    expect(stored.map((f) => [f.name, f.mime])).toEqual([
      ['board.png', 'image/png'],
      ['logo.jpg', 'image/jpeg'],
      ['my shot.jpg', 'image/jpeg'],
    ])
    expect(stored[0]!.noteId).toBe(plan.summary.id)
    expect(new Uint8Array(stored[0]!.data)).toEqual(PNG)
    expect(report.attachments).toBe(3)

    const spec = await noteByTitle(sqlite, 'Spec')
    const shot = attached.find((a) => a.path === 'assets/my shot.jpg')!
    expect(spec.record.bodyMd).toContain(`![Shot](devot://file/${shot.id})`)
    // Remote, missing, refused and outside images stay as they were.
    expect(spec.record.bodyMd).toContain(
      '![Remote](https://example.com/r.png) ![Missing](missing.png) ![Up](../../../outside.png)',
    )
    expect(spec.record.bodyMd).toContain('![Vector](../../assets/icon.svg)')
    expect(spec.record.bodyMd).toContain('![not an image](img/in-fence.png)')
    expect(report.problems).toEqual([
      {
        path: 'Projects/Deep/Spec.md',
        image: 'Projects/Deep/missing.png',
        code: 'E_IMPORT_FILE_NOT_FOUND',
      },
      {
        path: 'Projects/Deep/Spec.md',
        image: '../../../outside.png',
        code: 'E_IMPORT_PATH_OUTSIDE',
      },
      { path: 'Projects/Deep/Spec.md', image: 'assets/icon.svg', code: 'E_FILE_TYPE_REFUSED' },
    ])
  })

  it('writes every body through Yjs, so the snapshot is always the document text', async () => {
    const { sqlite, writes, services } = await setup()
    await importMarkdown({ ...services, scan: scanOf(SAMPLE), source: sourceFor(sqlite).source })
    // `checked` refuses any write whose snapshot is not the Yjs text.
    expect(writes.length).toBeGreaterThan(0)
    for (const summary of await sqlite.listNotes()) {
      const record = (await sqlite.getNote(summary.id))!
      const doc = new Y.Doc()
      Y.applyUpdate(doc, record.ydoc)
      expect(doc.getText(BODY).toString()).toBe(record.bodyMd)
      // The editor opens the same text.
      const opened = new Y.Doc()
      Y.applyUpdate(opened, (await services.notes.open(summary.id)).state)
      expect(opened.getText(BODY).toString()).toBe(record.bodyMd)
    }
  })

  it('keeps the source text: only image destinations change, and they map back', async () => {
    const { sqlite, services } = await setup()
    const { source, attached } = sourceFor(sqlite)
    await importMarkdown({ ...services, scan: scanOf(SAMPLE), source })
    for (const [path, title] of Object.entries(TITLES)) {
      // Line breaks are the one other change (see the next test).
      const original = lineFeeds(SAMPLE[path]!)
      const note = await noteByTitle(sqlite, title)
      const body = note.record.bodyMd
      const ids = new Map(
        attached.filter((a) => a.noteId === note.summary.id).map((a) => [a.path, a.id]),
      )
      // The body is the source with each imported image's destination replaced.
      const edits = imageLinks(original).flatMap((link) => {
        const target = resolveImagePath(path, link.url)
        const id = target === null ? undefined : ids.get(target)
        return id ? [{ start: link.start, end: link.end, text: `devot://file/${id}` }] : []
      })
      expect(edits).toHaveLength(path === 'Projects/Plan.md' ? 3 : path.includes('Spec') ? 1 : 0)
      expect(body).toBe(replaceRanges(original, edits))
      // Putting the original destinations back gives the source, byte for byte.
      const before = imageLinks(original)
      const after = imageLinks(body)
      expect(after).toHaveLength(before.length)
      const restored = replaceRanges(
        body,
        after.map((link, i) => ({
          start: link.start,
          end: link.end,
          text: original.slice(before[i]!.start, before[i]!.end),
        })),
      )
      expect(restored).toBe(original)
    }
    expect((await noteByTitle(sqlite, 'Spec')).record.bodyMd).toContain(`Text in ${CJK} stays.`)
  })

  it("keeps an image's size fragment on its attachment link; drops any other fragment", async () => {
    const { sqlite, services } = await setup()
    const files = {
      'Sized.md': [
        '# Sized',
        '',
        '![a](img/shot.png#half) ![b](img/shot.png) ![c](<img/shot.png#small>)',
        '![d](img/shot.png\\#full "Full") ![e](img/shot.png#other) ![f](img/shot.png?v=1#half)',
        '',
      ].join('\n'),
    }
    const { source, attached } = sourceFor(sqlite, files, { 'img/shot.png': PNG })
    const report = await importMarkdown({ ...services, scan: scanOf(files), source })
    expect(report).toMatchObject({ notes: 1, attachments: 1, problems: [] })
    // One file, without the fragment, whatever size each link shows it at.
    expect(attached.map((a) => a.path)).toEqual(['img/shot.png'])
    const file = `devot://file/${attached[0]!.id}`
    expect((await noteByTitle(sqlite, 'Sized')).record.bodyMd).toBe(
      [
        '# Sized',
        '',
        `![a](${file}#half) ![b](${file}) ![c](${file}#small)`,
        `![d](${file}#full "Full") ![e](${file}) ![f](${file}#half)`,
        '',
      ].join('\n'),
    )
  })

  it('stores every line break as \\n, so the editor and the Yjs text agree on offsets', async () => {
    const { sqlite, services } = await setup()
    const files = {
      'Windows.md': '# Windows\r\n\r\nOne\r\nTwo\r\n',
      'Classic.md': '# Classic\rOne\rTwo\r',
      'Mixed.md': `---\r\n${EXPORT_HEADER}\r\ntags: [a]\r\n---\r\n# Mixed\nOne\r\n![p](p.png)\r`,
    }
    const { source } = sourceFor(sqlite, files, { 'p.png': PNG })
    const report = await importMarkdown({ ...services, scan: scanOf(files), source })
    expect(report).toMatchObject({ notes: 3, attachments: 1, problems: [] })
    expect((await noteByTitle(sqlite, 'Windows')).record.bodyMd).toBe('# Windows\n\nOne\nTwo\n')
    expect((await noteByTitle(sqlite, 'Classic')).record.bodyMd).toBe('# Classic\nOne\nTwo\n')
    const mixed = await noteByTitle(sqlite, 'Mixed')
    expect(mixed.record.bodyMd).toMatch(/^# Mixed\nOne\n!\[p\]\(devot:\/\/file\/[0-9a-f-]{36}\)\n$/)
    expect(await sqlite.listTags()).toMatchObject([{ name: 'a' }])
    for (const summary of await sqlite.listNotes()) {
      const opened = new Y.Doc()
      Y.applyUpdate(opened, (await services.notes.open(summary.id)).state)
      const text = opened.getText(BODY)
      // CodeMirror reads a CRLF as one line break; the Yjs text must too.
      expect(EditorState.create({ doc: text.toString() }).doc.length).toBe(text.length)
    }
  })

  it('keeps [[...]] as plain text: no note links are made', async () => {
    const { sqlite, services } = await setup()
    await importMarkdown({ ...services, scan: scanOf(SAMPLE), source: sourceFor(sqlite).source })
    const inbox = await noteByTitle(sqlite, 'Inbox')
    expect(inbox.record.bodyMd).toBe(SAMPLE['Inbox.md'])
    expect(sqlite.db.prepare('SELECT count(*) AS n FROM links').get()).toEqual({ n: 0 })
  })

  it('takes the title from the first H1, then the file name, never from foreign front matter', async () => {
    const { sqlite, services } = await setup()
    await importMarkdown({ ...services, scan: scanOf(SAMPLE), source: sourceFor(sqlite).source })
    const titles = (await sqlite.listNotes()).map((n) => n.title).sort()
    expect(titles).toEqual(['Ancient', 'Inbox', 'Plan heading', 'Spec'])
  })

  it('reports files that cannot be read and goes on with the rest', async () => {
    const { sqlite, services } = await setup()
    const files = { 'a.md': '# A\n', 'b.md': '# B\n', 'c.md': '# C\n' }
    const { source } = sourceFor(sqlite, files)
    const failing: ImportSource = {
      ...source,
      read: (path) =>
        path === 'b.md' ? Promise.reject(new Error('E_IMPORT_NOT_UTF8')) : source.read(path),
    }
    const progress: [number, number][] = []
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files, { skipped: [{ path: 'huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }] }),
      source: failing,
      onProgress: (done, total) => void progress.push([done, total]),
    })
    expect((await sqlite.listNotes()).map((n) => n.title).sort()).toEqual(['A', 'C'])
    expect(report.notes).toBe(2)
    expect(report.problems).toEqual([
      { path: 'huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' },
      { path: 'b.md', code: 'E_IMPORT_NOT_UTF8' },
    ])
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it('takes back the notebooks made for a file whose note cannot be made', async () => {
    const { sqlite, services } = await setup()
    // The failing file comes first, so even the folder's notebook is made for it.
    const files = { 'A/Deep/a.md': '# A\n', 'Other/b.md': '# B\n' }
    const failing = {
      ...services.notes,
      create: (title?: string, bookId?: string | null) =>
        title === 'A'
          ? Promise.reject(new Error('E_TEST_WRITE_FAILED'))
          : services.notes.create(title, bookId),
    }
    const report = await importMarkdown({
      ...services,
      notes: failing,
      scan: scanOf(files),
      source: sourceFor(sqlite, files).source,
    })
    expect(report.problems).toEqual([{ path: 'A/Deep/a.md', code: 'E_TEST_WRITE_FAILED' }])
    expect(report).toMatchObject({ notes: 1, books: 1 })
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual([['Vault', ['Other']]])
  })

  it('stops after the file it is on when asked, and lists the rest', async () => {
    const { sqlite, services } = await setup()
    const files = { 'a.md': '# A\n![p](p.png)\n', 'b.md': '# B\n', 'c.md': '# C\n' }
    const { source } = sourceFor(sqlite, files, { 'p.png': PNG })
    let stop = false
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files),
      source: {
        ...source,
        // Asked to stop while the first file is half done.
        attach: (path, file) => {
          stop = true
          return source.attach(path, file)
        },
      },
      stopped: () => stop,
    })
    expect(report).toMatchObject({ notes: 1, attachments: 1 })
    expect(report.problems).toEqual([
      { path: 'b.md', code: 'E_IMPORT_STOPPED' },
      { path: 'c.md', code: 'E_IMPORT_STOPPED' },
    ])
    const a = await noteByTitle(sqlite, 'A')
    expect(a.record.bodyMd).toMatch(/^# A\n!\[p\]\(devot:\/\/file\//)
    expect((await sqlite.listNotes()).map((n) => n.title)).toEqual(['A'])
  })

  it('says so when a failed file cannot be cleaned up', async () => {
    const { sqlite, services } = await setup()
    const files = { 'a.md': '# A\n' }
    const failing = {
      ...services.notes,
      setBody: () => Promise.reject(new Error('E_TEST_WRITE_FAILED')),
      trash: () => Promise.reject(new Error('E_TEST_TRASH_FAILED')),
    }
    const report = await importMarkdown({
      ...services,
      notes: failing,
      scan: scanOf(files),
      source: sourceFor(sqlite, files).source,
    })
    expect(report.problems).toEqual([
      { path: 'a.md', code: 'E_TEST_WRITE_FAILED' },
      { path: 'a.md', code: 'E_IMPORT_INCOMPLETE' },
    ])
  })

  it('gives an error code, never content, for unexpected failures', async () => {
    const { sqlite, services } = await setup()
    const files = { 'a.md': '# A\n' }
    const { source } = sourceFor(sqlite, files)
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files),
      source: { ...source, read: () => Promise.reject(new Error('secret note text')) },
    })
    expect(report.problems).toEqual([{ path: 'a.md', code: 'E_IMPORT_FAILED' }])
  })

  it('makes no notebook for an empty folder or one whose files all fail', async () => {
    const { sqlite, services } = await setup()
    const empty = await importMarkdown({
      ...services,
      scan: scanOf({}, { name: 'Empty' }),
      source: sourceFor(sqlite, {}).source,
    })
    expect(empty).toEqual({ bookId: null, notes: 0, books: 0, attachments: 0, problems: [] })
    const files = { 'Good.md': '# Good\n', 'Bad/One.md': '', 'Bad/Deeper/Two.md': '' }
    const { source } = sourceFor(sqlite, files)
    await importMarkdown({
      ...services,
      scan: scanOf(files),
      source: {
        ...source,
        read: (path) =>
          path.startsWith('Bad/')
            ? Promise.reject(new Error('E_IMPORT_NOT_UTF8'))
            : source.read(path),
      },
    })
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual(['Vault'])
  })

  it('leaves nothing behind when a file fails after its note was made', async () => {
    const { sqlite, services } = await setup()
    const files = {
      'Sub/Deep/a.md': '---\ntags: [only-a]\n---\n# A\n\n![p](p.png)\n',
      'b.md': '# B\n',
    }
    const images = { 'Sub/Deep/p.png': PNG }
    const failing = {
      ...services.notes,
      setBody: (id: string, markdown: string) =>
        markdown.includes('# A')
          ? Promise.reject(new Error('E_TEST_WRITE_FAILED'))
          : services.notes.setBody(id, markdown),
    }
    const report = await importMarkdown({
      ...services,
      notes: failing,
      scan: scanOf(files),
      source: sourceFor(sqlite, files, images).source,
    })
    expect(report.problems).toEqual([{ path: 'Sub/Deep/a.md', code: 'E_TEST_WRITE_FAILED' }])
    expect(report).toMatchObject({ notes: 1, books: 0, attachments: 0 })
    expect((await sqlite.listNotes()).map((n) => n.title)).toEqual(['B'])
    expect(await sqlite.listTrash()).toEqual([])
    expect(sqlite.db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 })
    // Neither the notebooks nor the tags made for it are left behind.
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual(['Vault'])
    expect(await sqlite.listTags()).toEqual([])
  })
})

describe('import preview', () => {
  const scan = (kind: ImportScan['kind'], notes: string[], images: string[] = []): ImportScan => ({
    id: 1,
    name: 'Vault',
    kind,
    files: notes.map((path) => ({ path, bytes: 100 })),
    images: images.map((path) => ({ path, bytes: 1000 })),
    skipped: [{ path: 'Huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }],
  })
  const shape = (node: ImportFolder): unknown => [
    node.name,
    node.notebook,
    node.notes,
    node.images,
    node.bytes,
    ...(node.folders.length ? [node.folders.map(shape)] : []),
  ]

  it('counts notes, images and bytes per folder; the picked folder is no notebook', () => {
    const tree = importTree(
      scan('folder', ['a.md', 'Work/b.md', 'Work/Deep/c.md'], ['Work/img/x.png', 'Photos/y.png']),
    )
    expect(shape(tree)).toEqual([
      'Vault',
      false,
      3,
      2,
      2300,
      [
        ['Photos', false, 0, 1, 1000],
        [
          'Work',
          true,
          2,
          1,
          1200,
          [
            ['Deep', true, 1, 0, 100],
            ['img', false, 0, 1, 1000],
          ],
        ],
      ],
    ])
  })

  it('makes each of several picked folders a notebook', () => {
    const tree = importTree(scan('folders', ['Home/a.md', 'Work/b.md', 'Work/Sub/c.md']))
    expect(tree.notebook).toBe(false)
    expect(shape(tree)).toEqual([
      'Vault',
      false,
      3,
      0,
      300,
      [
        ['Home', true, 1, 0, 100],
        ['Work', true, 2, 0, 200, [['Sub', true, 1, 0, 100]]],
      ],
    ])
  })

  it('puts picked files straight into the destination', () => {
    expect(shape(importTree(scan('files', ['Docs/a.html', 'Other/b.htm'])))).toEqual([
      'Vault',
      false,
      2,
      0,
      200,
    ])
  })

  it('agrees with the import on which folders become notebooks', async () => {
    const { sqlite, services } = await setup()
    const files = { 'a.md': '# A\n', 'Work/Deep/b.md': '# B\n', 'Home/c.md': '# C\n' }
    const picked = { ...scanOf(files), images: items(['Photos/p.png']) }
    const planned: string[] = []
    const walkTree = (node: ImportFolder) => {
      if (node.notebook) planned.push(node.name)
      node.folders.forEach(walkTree)
    }
    walkTree(importTree(picked))
    // Planning writes nothing.
    expect(names(buildBookTree(await sqlite.listBooks()))).toEqual(['Vault'])
    expect(await sqlite.listNotes()).toEqual([])
    await importMarkdown({ ...services, scan: picked, source: sourceFor(sqlite, files).source })
    const made = (await sqlite.listBooks()).map((b) => b.name).filter((n) => n !== 'Vault')
    expect(made.sort()).toEqual(planned.sort())
  })

  it('lists files Rust left out as skipped, with their code, and imports the rest', async () => {
    const { sqlite, services } = await setup()
    const files = { 'a.md': '# A\n' }
    const report = await importMarkdown({
      ...services,
      scan: scanOf(files, { skipped: [{ path: 'Huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }] }),
      source: sourceFor(sqlite, files).source,
    })
    expect(report).toMatchObject({
      notes: 1,
      problems: [{ path: 'Huge.md', code: 'E_IMPORT_FILE_TOO_LARGE' }],
    })
  })
})
