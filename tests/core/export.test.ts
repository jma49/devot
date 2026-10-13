import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachmentIds,
  buildBookTree,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  EXPORT_HEADER,
  exportHeader,
  exportMarkdown,
  fileStem,
  importMarkdown,
  linkPath,
  markdownFile,
  nameKey,
  planExport,
  readFrontMatter,
  relativeHref,
  type BookNode,
  type ExportSink,
  type ImportScan,
  type ImportSource,
  type NoteStatus,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 2])
// Written as code points: no CJK characters in the source.
const CJK = String.fromCodePoint(0x4e2d, 0x6587, 0x7b14, 0x8bb0)
const ID1 = '0192a6f0-0000-7000-8000-00000000f001'
const ID2 = '0192a6f0-0000-7000-8000-00000000f002'
/** UUID-shaped but version 4: no attachment has such an ID (Rust refuses it). */
const V4 = '0192a6f0-0000-4000-8000-00000000f003'
const NOTE = '0192a6f0-0000-7000-8000-000000000009'

const entry = (
  bodyMd: string,
  more: Partial<{ title: string; tags: string[]; status: NoteStatus }> = {},
) => ({
  title: 'Plan',
  tags: [],
  status: 'none' as NoteStatus,
  bodyMd,
  ...more,
})

describe('names', () => {
  it('makes titles safe file names', () => {
    expect(fileStem('Plan', 'Untitled')).toBe('Plan')
    expect(fileStem('a/b: c\\d', 'Untitled')).toBe('a b c d')
    expect(fileStem('  ..hidden  ', 'Untitled')).toBe('hidden')
    expect(fileStem('one\ntwo\u0000three', 'Untitled')).toBe('one two three')
    expect(fileStem('', 'Untitled')).toBe('Untitled')
    expect(fileStem('...', 'Untitled')).toBe('Untitled')
    expect(fileStem(`${CJK} notes`, 'Untitled')).toBe(`${CJK} notes`)
    // At most 200 UTF-8 bytes, never cut inside a character.
    const long = fileStem(CJK.repeat(30), 'Untitled')
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(200)
    expect(long).toBe(CJK.repeat(30).slice(0, 66))
  })

  it('percent-encodes only what would break a link destination', () => {
    expect(linkPath('attachments/board.png')).toBe('attachments/board.png')
    expect(linkPath('../attachments/my shot (1).png')).toBe(
      '../attachments/my%20shot%20%281%29.png',
    )
    expect(linkPath('attachments/100%#?<x>.png')).toBe('attachments/100%25%23%3F%3Cx%3E.png')
    expect(linkPath(`attachments/${CJK}.png`)).toBe(`attachments/${CJK}.png`)
  })

  it('links one exported page to another relatively, from any folder', () => {
    // Same folder.
    expect(relativeHref([], ['Plan.html'])).toBe('Plan.html')
    expect(relativeHref(['Plans'], ['Plans', 'Plan.html'])).toBe('Plan.html')
    // Down into a sub-notebook's folder, and back up.
    expect(relativeHref([], ['Plans', 'Plan.html'])).toBe('Plans/Plan.html')
    expect(relativeHref(['Plans'], ['Inbox.html'])).toBe('../Inbox.html')
    // Across to a sibling folder, two levels deep.
    expect(relativeHref(['A', 'B', 'C'], ['A', 'D', 'E', 'x.html'])).toBe('../../D/E/x.html')
    // A folder named like the page is still a folder.
    expect(relativeHref(['A', 'B'], ['A', 'B.html'])).toBe('../B.html')
    expect(relativeHref(['Plan'], ['Plan.html'])).toBe('../Plan.html')
    // Each name percent-encoded, so `#`, `%` and spaces stay part of it.
    expect(relativeHref([], ['My notes', '100% #1?.html'])).toBe('My%20notes/100%25%20%231%3F.html')
    expect(relativeHref(['My notes'], [`${CJK}.html`])).toBe(`../${encodeURIComponent(CJK)}.html`)
  })
})

describe('Markdown files', () => {
  it('points attachment links at the copied files, relative to the note', () => {
    const body = [
      '# Plan',
      '',
      `![Board](devot://file/${ID1} "The board") and again ![same](<devot://file/${ID1}>).`,
      '',
      '![Logo][logo]',
      '',
      `[logo]: devot://file/${ID2}`,
      '',
      '```md',
      `![in code](devot://file/${ID1})`,
      '```',
      '',
      `[A note](devot://note/${NOTE}) and ![remote](https://example.com/r.png)`,
      '',
    ].join('\n')
    expect(attachmentIds(body)).toEqual([ID1, ID2])
    const paths = new Map([
      [ID1, '../attachments/my board.png'],
      [ID2, '../attachments/logo.jpg'],
    ])
    const out = markdownFile(entry(body), 'Plan.md', paths)
    expect(out).toBe(
      body
        .replace(`(devot://file/${ID1} "`, '(../attachments/my%20board.png "')
        .replace(`(<devot://file/${ID1}>)`, '(../attachments/my%20board.png)')
        .replace(`[logo]: devot://file/${ID2}`, '[logo]: ../attachments/logo.jpg'),
    )
    // Code stays as written; note links and remote images too.
    expect(out).toContain(`![in code](devot://file/${ID1})`)
    expect(out).toContain(`[A note](devot://note/${NOTE})`)
    // An attachment that could not be copied keeps its link.
    expect(markdownFile(entry(body), 'Plan.md', new Map())).toBe(body)
  })

  it('finds the attachments of <img> tags in raw HTML in a note with no Markdown image', () => {
    // Nothing starts with `![` here: the tags alone show the attachments.
    const body = [
      `<p align="center"><IMG SRC="devot://file/${ID1}" width="300"></p>`,
      '',
      `Text <img src='devot://file/${ID2}#half'>.`,
      '',
    ].join('\n')
    expect(attachmentIds(body)).toEqual([ID1, ID2])
    const paths = new Map([
      [ID1, 'attachments/my board.png'],
      [ID2, "attachments/it's.png"],
    ])
    expect(markdownFile(entry(body), 'Plan.md', paths)).toBe(
      [
        '<p align="center"><IMG SRC="attachments/my%20board.png" width="300"></p>',
        '',
        "Text <img src='attachments/it%27s.png#half'>.",
        '',
      ].join('\n'),
    )
  })

  it('leaves a devot:// image whose ID is not an attachment ID (UUIDv7) as written', () => {
    const body = `![a](devot://file/${ID1}) ![old](devot://file/${V4}) ![b](devot://file/${V4}#half)\n`
    // Rust refuses such an ID, so it is no attachment: nothing to copy.
    expect(attachmentIds(body)).toEqual([ID1])
    const paths = new Map([
      [ID1, '../attachments/a.png'],
      [V4, '../attachments/old.png'],
    ])
    expect(markdownFile(entry(body), 'Plan.md', paths)).toBe(
      body.replace(`devot://file/${ID1}`, '../attachments/a.png'),
    )
  })

  it("keeps an image's size as a fragment on its attachment's relative path", () => {
    const body = [
      `![a](devot://file/${ID1}#half) ![b](devot://file/${ID1}) ![c](<devot://file/${ID1}#small>)`,
      `![d](devot://file/${ID2}\\#full "Full")`,
      // Not a size: not an attachment link either (the preview drops it too).
      `![e](devot://file/${ID1}#other)`,
      '',
    ].join('\n')
    // Each attachment once, sized or not.
    expect(attachmentIds(body)).toEqual([ID1, ID2])
    const paths = new Map([
      [ID1, '../attachments/my shot.png'],
      [ID2, '../attachments/full#1.png'],
    ])
    expect(markdownFile(entry(body), 'Plan.md', paths)).toBe(
      [
        '![a](../attachments/my%20shot.png#half) ![b](../attachments/my%20shot.png) ![c](../attachments/my%20shot.png#small)',
        '![d](../attachments/full%231.png#full "Full")',
        `![e](devot://file/${ID1}#other)`,
        '',
      ].join('\n'),
    )
  })

  it('writes the body as it is when the file name or first heading gives the title', () => {
    expect(markdownFile(entry('# Plan\n\nText\n'), 'Other.md', new Map())).toBe('# Plan\n\nText\n')
    expect(markdownFile(entry('Text\n'), 'Plan.md', new Map())).toBe('Text\n')
  })

  it("adds Devot's front matter for a title, tags or status import would not read back", () => {
    const out = markdownFile(
      entry('# Other heading\n\nText\n', {
        title: "Plan: Bob's",
        tags: ['work', "it's, quoted", 'q4 goals'],
        status: 'on_hold',
      }),
      'Plan Bobs.md',
      new Map(),
    )
    expect(out).toBe(
      [
        '---',
        EXPORT_HEADER,
        "title: 'Plan: Bob''s'",
        "tags: ['work', 'it''s, quoted', 'q4 goals']",
        'status: on-hold',
        '---',
        '# Other heading',
        '',
        'Text',
        '',
      ].join('\n'),
    )
    // Import reads it back and leaves it out of the note.
    expect(readFrontMatter(out)).toEqual({
      title: "Plan: Bob's",
      notebook: null,
      tags: ['work', "it's, quoted", 'q4 goals'],
      status: 'on_hold',
    })
    expect(exportHeader(out)?.body).toBe('# Other heading\n\nText\n')
    // A body that starts with a rule keeps it.
    const ruled = markdownFile(entry('---\nText\n', { tags: ['a'] }), 'Plan.md', new Map())
    expect(exportHeader(ruled)?.body).toBe('---\nText\n')
    // An untitled note keeps its empty title.
    const untitled = markdownFile(entry('Text\n', { title: '' }), 'Untitled.md', new Map())
    expect(exportHeader(untitled)?.meta.title).toBe('')
  })

  it('sets the keys that disagree in a note with front matter of its own', () => {
    const own = ['---', 'title: Plan', 'tags:', '  - work', 'author: me', '---', 'Text', ''].join(
      '\n',
    )
    // It already says everything: kept as written.
    expect(markdownFile(entry(own, { tags: ['work'] }), 'x.md', new Map())).toBe(own)
    const out = markdownFile(
      entry(own, { title: 'Renamed', tags: ['work', 'new'], status: 'active' }),
      'x.md',
      new Map(),
    )
    expect(out).toBe(
      [
        '---',
        'author: me',
        "title: 'Renamed'",
        "tags: ['work', 'new']",
        'status: active',
        '---',
        'Text',
        '',
      ].join('\n'),
    )
    expect(exportHeader(out)).toBeNull()
  })
})

// --- On real SQLite and real files -------------------------------------------

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function library() {
  const sqlite = openSqliteAdapter(join(tempDir('devot-export-'), 'db.sqlite'))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const services = {
    notes: createNoteService({ storage: sqlite, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage: sqlite, clock, newId }),
    tags: createTagService({ storage: sqlite, clock, newId }),
  }
  return { sqlite, newId, services }
}

type Library = ReturnType<typeof library>

/** A sink writing into `root` like the Rust commands: attachments from the database. */
function folderSink(sqlite: SqliteAdapter, root: string, fileName?: string) {
  const written: string[] = []
  const sink: ExportSink = {
    async begin() {
      mkdirSync(root, { recursive: true })
      return { fileName: fileName ?? null }
    },
    async attach(fileId) {
      const file = sqlite.db.prepare('SELECT name, data FROM files WHERE id = ?').get(fileId) as
        | { name: string; data: Buffer }
        | undefined
      if (!file) throw new Error('E_FILE_NOT_FOUND')
      const path = `attachments/${file.name}`
      mkdirSync(join(root, 'attachments'), { recursive: true })
      writeFileSync(join(root, path), file.data)
      return path
    },
    async write(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
      written.push(path)
    },
  }
  return { sink, written }
}

/** Every file under `root`, relative, sorted. */
function walk(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel))
    .sort()
    .flatMap((name) => {
      const path = rel ? `${rel}/${name}` : name
      return statSync(join(root, path)).isDirectory() ? walk(root, path) : [path]
    })
}

/** Imports the folder at `root` as Rust would scan it (Markdown files, sorted). */
async function importFolder(lib: Library, root: string, name: string) {
  const files = walk(root).filter((p) => p.endsWith('.md'))
  const scan: ImportScan = { id: 1, name, files, skipped: [] }
  const source: ImportSource = {
    read: async (path) => readFileSync(join(root, path), 'utf8'),
    async attach(path, file) {
      await lib.sqlite.putFile(
        { ...file, name: path.split('/').pop() ?? 'image' },
        readFileSync(join(root, path)),
      )
    },
  }
  return importMarkdown({ ...lib.services, newId: lib.newId, scan, source })
}

/** A note's body with each attachment link showing its bytes instead of its ID. */
function bodyWithBytes(sqlite: SqliteAdapter, body: string): string {
  return body.replace(/devot:\/\/file\/([0-9a-f-]{36})/g, (_, id: string) => {
    const file = sqlite.db.prepare('SELECT data FROM files WHERE id = ?').get(id) as
      | { data: Buffer }
      | undefined
    return `file:${file ? Buffer.from(file.data).toString('hex') : 'missing'}`
  })
}

/** Everything about the notes that a round trip must keep, by notebook path. */
async function snapshot(lib: Library, rootName?: string) {
  const books = await lib.sqlite.listBooks()
  const tags = new Map((await lib.sqlite.listTags()).map((t) => [t.id, t.name]))
  const pathOf = (id: string | null): string => {
    const book = books.find((b) => b.id === id)
    if (!book) return ''
    const parent = pathOf(book.parentId)
    return parent ? `${parent}/${book.name}` : book.name
  }
  const notes = await Promise.all(
    (await lib.sqlite.listNotes()).map(async (n) => {
      const record = (await lib.sqlite.getNote(n.id))!
      return {
        book: pathOf(n.bookId),
        title: n.title,
        body: bodyWithBytes(lib.sqlite, record.bodyMd),
        tags: n.tagIds.map((t) => tags.get(t)).sort(),
        status: n.status,
      }
    }),
  )
  const filtered = rootName ? notes.filter((n) => n.book.split('/')[0] === rootName) : notes
  return filtered.sort(byPlace)
}

/** Notes in order of notebook, title and body. */
const byPlace = (a: { book: string; title: string; body: string }, b: typeof a) =>
  `${a.book}/${a.title}/${a.body}`.localeCompare(`${b.book}/${b.title}/${b.body}`)

const tree = (nodes: BookNode[]): unknown[] =>
  nodes.map((n) => (n.children.length ? [n.name, tree(n.children)] : n.name))

/** A library with nested notebooks, tags, statuses, images and clashing names. */
async function sampleLibrary() {
  const lib = library()
  const { notes, books, tags } = lib.services
  const work = await books.create('Work', null)
  const plans = await books.create('Plans: 2026', work)
  const deep = await books.create('Deep', plans)
  const attachments = await books.create('attachments', work)
  const other = await books.create('Elsewhere', null)
  const note = async (
    title: string,
    book: string,
    body: string | ((id: string) => Promise<string>),
    meta: { tags?: string[]; status?: NoteStatus } = {},
  ) => {
    const id = await notes.create(title, book)
    await notes.setBody(id, typeof body === 'string' ? body : await body(id))
    for (const tag of meta.tags ?? []) await tags.addToNote(id, tag)
    if (meta.status) await notes.setStatus(id, meta.status)
    await notes.release(id)
    return id
  }
  const image = async (noteId: string, name: string, bytes: Uint8Array) => {
    const id = lib.newId()
    await lib.sqlite.putFile({ id, noteId, name }, bytes)
    return id
  }
  await note('Inbox', work, '# Inbox\n\nLoose thoughts.\n')
  await note(
    'Launch plan',
    plans,
    async (id) => {
      const board = await image(id, 'board.png', PNG)
      const shot = await image(id, 'my shot (1).jpg', JPEG)
      return [
        '# Plan heading',
        '',
        `![Board](devot://file/${board} "The board") and ![again](devot://file/${board}).`,
        '',
        // Sized: the same file as above, and one only shown sized.
        `![half](devot://file/${board}#half) ![Shot][shot]`,
        '',
        `[shot]: devot://file/${shot}`,
        '',
        '- [ ] task',
        '',
        `Text in ${CJK}.`,
        '',
      ].join('\n')
    },
    { tags: ['work', "q4's goals"], status: 'on_hold' },
  )
  // Two notes with one title, in one notebook; a title with a slash.
  await note('Spec', deep, 'First spec.\n', { status: 'completed' })
  await note(
    'Spec',
    deep,
    async (id) => `![p](devot://file/${await image(id, 'board.png', JPEG)}#small)\n`,
  )
  await note('a/b', deep, '# a/b\n')
  await note('', attachments, 'An untitled note.\n', { tags: ['misc'] })
  await note(
    'Own matter',
    work,
    ['---', 'title: Own matter', 'tags: [work]', 'author: me', '---', 'Body.', ''].join('\n'),
    { tags: ['work'] },
  )
  await note('Not exported', other, 'Elsewhere.\n')
  return { lib, work }
}

describe('Markdown export', () => {
  it('writes a notebook as nested folders of .md files with an attachments folder', async () => {
    const { lib, work } = await sampleLibrary()
    const root = join(tempDir('devot-export-out-'), 'Work')
    const { sink } = folderSink(lib.sqlite, root)
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: work },
      untitled: 'Untitled',
      sink,
    })
    expect(report).toEqual({ notes: 7, attachments: 3, problems: [] })
    expect(walk(root)).toEqual([
      'Inbox.md',
      'Own matter.md',
      'Plans 2026/Deep/Spec 2.md',
      'Plans 2026/Deep/Spec.md',
      'Plans 2026/Deep/a b.md',
      'Plans 2026/Launch plan.md',
      'attachments/board.png',
      'attachments/my shot (1).jpg',
      'attachments 2/Untitled.md',
    ])
    // The two Specs' images share a name; the sink keeps the last, so the
    // Rust side numbers them (tested there). Here, check the links.
    const plan = readFileSync(join(root, 'Plans 2026/Launch plan.md'), 'utf8')
    expect(plan).toContain('![Board](../attachments/board.png "The board")')
    expect(plan).toContain('![again](../attachments/board.png)')
    expect(plan).toContain('![half](../attachments/board.png#half) ![Shot][shot]')
    expect(plan).toContain('[shot]: ../attachments/my%20shot%20%281%29.jpg')
    expect(plan.startsWith(`---\n${EXPORT_HEADER}\ntitle: 'Launch plan'\n`)).toBe(true)
    expect(readFileSync(join(root, 'Inbox.md'), 'utf8')).toBe('# Inbox\n\nLoose thoughts.\n')
    const deepSpec = readFileSync(join(root, 'Plans 2026/Deep/Spec 2.md'), 'utf8')
    expect(deepSpec).toContain('![p](../../attachments/board.png#small)')
  })

  it('round-trips: importing the export gives the same notes, notebooks and images', async () => {
    const { lib, work } = await sampleLibrary()
    // Distinct image names, so the folder sink's names are the Rust ones.
    lib.sqlite.db.prepare("UPDATE files SET name = id || '.' || substr(mime, 7)").run()
    const out = tempDir('devot-export-out-')
    const root = join(out, 'Work')
    await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: work },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root).sink,
    })

    const fresh = library()
    const report = await importFolder(fresh, root, 'Work')
    expect(report.problems).toEqual([])
    expect(report.notes).toBe(7)
    // Notebook names come back file-safe: no colon, and `attachments` is taken.
    const safe = (book: string) =>
      book.replace('Plans: 2026', 'Plans 2026').replace(/^Work\/attachments$/, 'Work/attachments 2')
    const before = (await snapshot(lib, 'Work')).map((n) => ({ ...n, book: safe(n.book) }))
    expect(await snapshot(fresh)).toEqual(before.sort(byPlace))
    // Sub-notebooks come back nested the same way (their names made file-safe).
    expect(tree(buildBookTree(await fresh.sqlite.listBooks()))).toEqual([
      ['Work', [['Plans 2026', ['Deep']], 'attachments 2']],
    ])
  })

  it("round-trips an untitled note with front matter of its own, and tags that start with '#'", async () => {
    const lib = library()
    const { notes, books, tags } = lib.services
    const work = await books.create('Work', null)
    const note = async (title: string, body: string, tagNames: string[]) => {
      const id = await notes.create(title, work)
      await notes.setBody(id, body)
      for (const tag of tagNames) await tags.addToNote(id, tag)
      await notes.release(id)
    }
    const own = ['---', 'author: me', 'tags: [plain]', '---', '# A heading', '', 'Text.', ''].join(
      '\n',
    )
    // Import alone would title these after their heading or file name.
    await note('', own, ['plain'])
    await note('', own.replace('author: me', 'author: you'), ['#urgent', 'plain'])
    await note('Tagged', '# Tagged\n', ['#urgent', '##twice'])
    await note('Own tags', own.replace('# A heading', '# Own tags'), ['#later', 'plain'])
    const root = join(tempDir('devot-export-out-'), 'Work')
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: work },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root).sink,
    })
    expect(report?.problems).toEqual([])

    const fresh = library()
    expect((await importFolder(fresh, root, 'Work')).problems).toEqual([])
    expect(await snapshot(fresh)).toEqual(await snapshot(lib))
  })

  it('round-trips a single note saved under another file name', async () => {
    const { lib } = await sampleLibrary()
    const plan = (await lib.sqlite.listNotes()).find((n) => n.title === 'Launch plan')!
    const out = tempDir('devot-export-out-')
    const root = join(out, 'Folder')
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'note', noteId: plan.id },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root, 'renamed.md').sink,
    })
    expect(report).toEqual({ notes: 1, attachments: 2, problems: [] })
    expect(walk(root)).toEqual([
      'attachments/board.png',
      'attachments/my shot (1).jpg',
      'renamed.md',
    ])
    const fresh = library()
    await importFolder(fresh, root, 'Folder')
    const [before] = (await snapshot(lib)).filter((n) => n.title === 'Launch plan')
    expect(await snapshot(fresh)).toEqual([{ ...before, book: 'Folder' }])
  })

  it('plans a note under its title, or Untitled', async () => {
    const { lib } = await sampleLibrary()
    const untitled = (await lib.sqlite.listNotes()).find((n) => n.title === '')!
    const plan = await planExport({
      ...lib.services,
      target: { kind: 'note', noteId: untitled.id },
      untitled: 'Untitled',
    })
    expect(plan).toMatchObject({
      name: 'Untitled',
      entries: [{ stem: 'Untitled', folder: [], tags: ['misc'], title: '' }],
    })
  })

  it("never gives a sub-notebook's folder a note's file name or the attachments folder", async () => {
    const lib = library()
    const { notes, books } = lib.services
    const top = await books.create('Top', null)
    const clash = await books.create('Plan.md', top)
    const reserved = await books.create('attachments', top)
    for (const [title, book] of [
      ['Plan', top],
      ['Inner', clash],
      ['Kept', reserved],
    ] as const) {
      await notes.release(await notes.create(title, book))
    }
    const plan = await planExport({
      ...lib.services,
      target: { kind: 'notebook', bookId: top },
      untitled: 'Untitled',
    })
    expect(plan.entries.map((e) => [...e.folder, e.stem].join('/')).sort()).toEqual([
      'Plan',
      'Plan.md 2/Inner',
      'attachments 2/Kept',
    ])
  })

  it('exports a note showing a devot:// image Rust would refuse, without a problem', async () => {
    const lib = library()
    const body = `# Old\n\n![old](devot://file/${V4})\n`
    const id = await lib.services.notes.create('Old', null)
    await lib.services.notes.setBody(id, body)
    await lib.services.notes.release(id)
    const root = join(tempDir('devot-export-out-'), 'Folder')
    const { sink } = folderSink(lib.sqlite, root, 'Old.md')
    const asked: string[] = []
    // Like Rust's export_attach, which refuses any ID that is not a UUIDv7.
    const strict: ExportSink = {
      ...sink,
      attach: (fileId) => {
        asked.push(fileId)
        return /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(fileId)
          ? sink.attach(fileId)
          : Promise.reject(new Error('E_FILE_ID_INVALID'))
      },
    }
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'note', noteId: id },
      untitled: 'Untitled',
      sink: strict,
    })
    expect(report).toEqual({ notes: 1, attachments: 0, problems: [] })
    expect(asked).toEqual([])
    expect(readFileSync(join(root, 'Old.md'), 'utf8')).toBe(body)
  })

  it('lists images that could not be copied and keeps their links; stops when cancelled', async () => {
    const { lib, work } = await sampleLibrary()
    const root = join(tempDir('devot-export-out-'), 'Work')
    const { sink } = folderSink(lib.sqlite, root)
    const failing: ExportSink = {
      ...sink,
      attach: (id) =>
        id.endsWith('x') ? sink.attach(id) : Promise.reject(new Error('E_FILE_NOT_FOUND')),
      write: (path, text) =>
        path === 'Inbox.md' ? Promise.reject(new Error('oops')) : sink.write(path, text),
    }
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: work },
      untitled: 'Untitled',
      sink: failing,
    })
    expect(report?.notes).toBe(6)
    expect(report?.attachments).toBe(0)
    expect(report?.problems.map((p) => p.code).sort()).toEqual([
      'E_EXPORT_FAILED',
      'E_FILE_NOT_FOUND',
      'E_FILE_NOT_FOUND',
      'E_FILE_NOT_FOUND',
    ])
    expect(readFileSync(join(root, 'Plans 2026/Launch plan.md'), 'utf8')).toContain(
      '![Board](devot://file/',
    )
    const cancelled = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: work },
      untitled: 'Untitled',
      sink: { ...sink, begin: async () => null },
    })
    expect(cancelled).toBeNull()
  })
})

// --- Names macOS takes for one ----------------------------------------------

// Written as code points: composed and decomposed forms look alike in source.
const E_ACUTE = String.fromCodePoint(0xe9)
const ACUTE = String.fromCodePoint(0x301)
const SHARP_S = String.fromCodePoint(0xdf)
const CAPITAL_SHARP_S = String.fromCodePoint(0x1e9e)
const FI = String.fromCodePoint(0xfb01)

describe('names macOS takes for one', () => {
  it('clash whatever their case, accents or ligatures', () => {
    const pairs = [
      [`Caf${E_ACUTE}`, `Cafe${ACUTE}`],
      [`CAF${E_ACUTE}`, `cafe${ACUTE}`],
      ['Masse', `Ma${SHARP_S}e`],
      [CAPITAL_SHARP_S, 'ss'],
      [`${FI}le`, 'file'],
      ['PLAN', 'plan'],
    ]
    for (const [a, b] of pairs) expect(nameKey(a!)).toBe(nameKey(b!))
    expect(nameKey('Plan')).not.toBe(nameKey('Plans'))
    expect(nameKey('Cafe')).not.toBe(nameKey(`Caf${E_ACUTE}`))
  })

  it('give every note a file and every notebook a folder of its own', async () => {
    const lib = library()
    const { notes, books } = lib.services
    const top = await books.create('Top', null)
    const titles = [
      `Caf${E_ACUTE}`,
      `Cafe${ACUTE}`,
      'Masse',
      `Ma${SHARP_S}e`,
      `${FI}le`,
      'file',
      'Plan',
      'PLAN',
    ]
    for (const title of titles) {
      const id = await notes.create(title, top)
      await notes.setBody(id, `Text of a note.\n`)
      await notes.release(id)
    }
    // Sibling notebooks whose names differ the same ways; and a note whose
    // file would clash with one of their folders.
    for (const name of [`Caf${E_ACUTE}`, `cafe${ACUTE}`]) {
      const book = await books.create(name, top)
      await notes.release(await notes.create(`Inside ${name}`, book))
    }
    const plan = await planExport({
      ...lib.services,
      target: { kind: 'notebook', bookId: top },
      untitled: 'Untitled',
    })
    const files = plan.entries.map((e) => nameKey([...e.folder, `${e.stem}.md`].join('/')))
    expect(new Set(files).size).toBe(titles.length + 2)
    const folders = new Set(plan.entries.map((e) => e.folder.map(nameKey).join('/')))
    expect(folders.size).toBe(3)

    // On disk (where the file system takes such names for one, on a Mac)
    // and back: every note comes back, with its title.
    const root = join(tempDir('devot-export-out-'), 'Top')
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: top },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root).sink,
    })
    expect(report?.problems).toEqual([])
    expect(walk(root)).toHaveLength(titles.length + 2)
    const fresh = library()
    const imported = await importFolder(fresh, root, 'Top')
    expect(imported.problems).toEqual([])
    expect(imported.notes).toBe(titles.length + 2)
    expect((await snapshot(fresh)).map((n) => n.title).sort()).toEqual(
      (await snapshot(lib)).map((n) => n.title).sort(),
    )
  })
})

// --- Devot's metadata, exactly ----------------------------------------------

const LINE_SEPARATOR = String.fromCodePoint(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029)
const CR = String.fromCodePoint(0xd)
const TAB = String.fromCodePoint(0x9)

/** Imports one exported file into a new library; the note it makes. */
async function importOne(fileName: string, text: string) {
  const lib = library()
  const report = await importMarkdown({
    ...lib.services,
    newId: lib.newId,
    scan: { id: 1, name: 'Folder', files: [fileName], skipped: [] },
    source: {
      read: async () => text,
      attach: async () => Promise.reject(new Error('E_IMPORT_FILE_NOT_FOUND')),
    },
  })
  expect(report.notes).toBe(1)
  const [note] = await snapshot(lib)
  return note!
}

describe("Devot's metadata", () => {
  it('reads back titles and tags with line separators, quotes and backslashes', async () => {
    const title = `Q1${LINE_SEPARATOR}plan "draft" \\ it's`
    const tags = [`a${LINE_SEPARATOR}b`, `c${PARAGRAPH_SEPARATOR}d`, 'it\'s, "x"', 'plain', '\\']
    const out = markdownFile(entry('Text.\n', { title, tags }), 'Q1 plan.md', new Map())
    // Each value stays on its line: no raw separator is written.
    expect(out).not.toContain(LINE_SEPARATOR)
    expect(out).not.toContain(PARAGRAPH_SEPARATOR)
    const note = await importOne('Q1 plan.md', out)
    expect(note.title).toBe(title)
    expect(note.tags).toEqual([...tags].sort())
    expect(note.body).toBe('Text.\n')
  })

  it("keeps a title's spaces and tabs exactly", async () => {
    for (const title of ['  two  spaces ', `tab${TAB}inside`, ' lead', 'trail ']) {
      const out = markdownFile(entry('Text.\n', { title }), 'x.md', new Map())
      expect((await importOne('x.md', out)).title).toBe(title)
    }
  })

  it('never lets a carriage return in a title spill into the body', async () => {
    const title = `a${CR}---${CR}b`
    const out = markdownFile(entry('Body.\n', { title, tags: ['t'] }), 'a b.md', new Map())
    expect(out).not.toContain(CR)
    const note = await importOne('a b.md', out)
    // A title is one line: the carriage returns read back as spaces.
    expect(note.title).toBe('a --- b')
    expect(note.tags).toEqual(['t'])
    expect(note.body).toBe('Body.\n')
  })

  it('reads a separator older exports wrote as it was', async () => {
    const old = [
      '---',
      EXPORT_HEADER,
      `title: 'a${LINE_SEPARATOR}b'`,
      "tags: ['x', 'y']",
      '---',
      'B',
      '',
    ].join('\n')
    const note = await importOne('x.md', old)
    expect(note.title).toBe(`a${LINE_SEPARATOR}b`)
    expect(note.tags).toEqual(['x', 'y'])
    expect(note.body).toBe('B\n')
  })

  it('compares tags exactly, case included', async () => {
    const own = ['---', 'tags: [work]', '---', '# Plan', ''].join('\n')
    const out = markdownFile(entry(own, { tags: ['Work'] }), 'Plan.md', new Map())
    expect(out).toBe(['---', "tags: ['Work']", '---', '# Plan', ''].join('\n'))
    expect((await importOne('Plan.md', out)).tags).toEqual(['Work'])
  })

  it("puts Devot's block first when the note's own front matter would read as one", async () => {
    const own = ['---', EXPORT_HEADER, 'author: me', '---', '# Plan', ''].join('\n')
    const out = markdownFile(entry(own), 'Plan.md', new Map())
    expect(exportHeader(out)?.body).toBe(own)
    const note = await importOne('Plan.md', out)
    expect(note.body).toBe(own)
    expect(note.title).toBe('Plan')
  })
})

// --- Every image a note shows -------------------------------------------------

describe('images', () => {
  /** A note in `book` showing an attachment of each name (distinct bytes each) as `body` says. */
  async function noteWithImages(
    lib: Library,
    book: string | null,
    names: string[],
    body: (uri: (name: string) => string) => string,
  ) {
    const id = await lib.services.notes.create('Images', book)
    const ids = new Map<string, string>()
    for (const [n, name] of names.entries()) {
      const fileId = lib.newId()
      await lib.sqlite.putFile({ id: fileId, noteId: id, name }, new Uint8Array([...PNG, n]))
      ids.set(name, fileId)
    }
    const text = body((name) => `devot://file/${ids.get(name)}`)
    await lib.services.notes.setBody(id, text)
    await lib.services.notes.release(id)
    return { id, ids, text }
  }

  it('exports and imports back every image a note shows, whatever its name', async () => {
    const lib = library()
    const top = await lib.services.books.create('Top', null)
    const narrow = String.fromCodePoint(0x202f)
    const shot = `Shot 12.34.56${narrow}PM.png`
    const odd = `a&b=c "d" 'e'.png`
    const names = ['Q&amp;A.png', 'Q1|Q2.png', shot, odd, 'html.png', 'sized.png', 'single.png']
    const { id } = await noteWithImages(lib, top, [...names, 'bare.png'], (uri) =>
      [
        '# Images',
        '',
        `![qa](${uri('Q&amp;A.png')})`,
        '',
        '| a | b |',
        '|---|---|',
        `| ![pipe](${uri('Q1|Q2.png')}) | x |`,
        '',
        `![shot](${uri(shot)}#half) ![odd](${uri(odd)})`,
        '',
        `<p align="center"><img src="${uri('html.png')}" width="300"></p>`,
        '',
        `Inline <img alt="s" src="${uri('sized.png')}#small"> and <img src='${uri('single.png')}'>.`,
        '',
        // Unquoted (in a block: inline, a value with a slash is no HTML).
        `<div><img src=${uri('bare.png')}></div>`,
        '',
      ].join('\n'),
    )
    const root = join(tempDir('devot-export-out-'), 'Top')
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: top },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root).sink,
    })
    expect(report).toEqual({ notes: 1, attachments: names.length + 1, problems: [] })
    const file = readFileSync(join(root, 'Images.md'), 'utf8')
    expect(file).not.toContain('devot://file/')
    expect(file).toContain('![qa](attachments/Q%26amp;A.png)')
    expect(file).toContain('| ![pipe](attachments/Q1%7CQ2.png) | x |')
    expect(file).toContain('<img src="attachments/html.png" width="300">')
    expect(file).toContain(`<img alt="s" src="attachments/sized.png#small">`)
    expect(file).toContain(`<img src='attachments/single.png'>`)
    expect(file).toContain('<div><img src=attachments/bare.png></div>')

    const fresh = library()
    const imported = await importFolder(fresh, root, 'Top')
    expect(imported.problems).toEqual([])
    expect(imported.attachments).toBe(names.length + 1)
    expect(await snapshot(fresh)).toEqual(await snapshot(lib))
    expect((await lib.sqlite.listNotes()).map((n) => n.id)).toEqual([id])
  })

  it('exports and imports back an HTML image after text that grows when lowercased', async () => {
    const lib = library()
    const top = await lib.services.books.create('Top', null)
    // A dotted capital I lowercases to two code units.
    const dotted = String.fromCodePoint(0x130)
    const names = ['after-text.png', 'after-script.png']
    await noteWithImages(lib, top, names, (uri) =>
      [
        `<p>${dotted}stanbul</p>`,
        `<img src="${uri('after-text.png')}" width="300">`,
        '',
        `<div><script>"${dotted.repeat(12)}"</SCRIPT><img src="${uri('after-script.png')}"></div>`,
        '',
      ].join('\n'),
    )
    const root = join(tempDir('devot-export-out-'), 'Top')
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'notebook', bookId: top },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root).sink,
    })
    expect(report).toEqual({ notes: 1, attachments: names.length, problems: [] })
    expect(walk(root)).toEqual([
      'Images.md',
      'attachments/after-script.png',
      'attachments/after-text.png',
    ])
    const file = readFileSync(join(root, 'Images.md'), 'utf8')
    expect(file).not.toContain('devot://file/')
    expect(file).toContain(`</p>\n<img src="attachments/after-text.png" width="300">`)
    expect(file).toContain(`</SCRIPT><img src="attachments/after-script.png"></div>`)

    const fresh = library()
    const imported = await importFolder(fresh, root, 'Top')
    expect(imported.problems).toEqual([])
    expect(imported.attachments).toBe(names.length)
    expect(await snapshot(fresh)).toEqual(await snapshot(lib))
  })

  it('lists an image it cannot point at its copy, and keeps its link', async () => {
    const lib = library()
    // What Markdown reads in place of a NUL is not what is written, so the
    // `src` cannot be found in the text.
    const nul = String.fromCodePoint(0)
    const { id, ids, text } = await noteWithImages(
      lib,
      null,
      ['odd.png'],
      (uri) => `<img src="${uri('odd.png')}" alt="${nul}">\n`,
    )
    const root = join(tempDir('devot-export-out-'), 'Folder')
    const report = await exportMarkdown({
      ...lib.services,
      target: { kind: 'note', noteId: id },
      untitled: 'Untitled',
      sink: folderSink(lib.sqlite, root, 'Images.md').sink,
    })
    expect(report).toEqual({
      notes: 1,
      attachments: 0,
      problems: [{ noteId: id, fileId: ids.get('odd.png'), code: 'E_EXPORT_IMAGE_UNLOCATED' }],
    })
    expect(readFileSync(join(root, 'Images.md'), 'utf8')).toContain(text)
  })

  it('imports images written by other tools: raw narrow spaces, HTML, and lists what it cannot', async () => {
    const root = join(tempDir('devot-import-in-'), 'Notes')
    const narrow = String.fromCodePoint(0x202f)
    const shot = `Screenshot 2026-10-10 at 12.34.56${narrow}PM.png`
    mkdirSync(join(root, 'img'), { recursive: true })
    for (const name of [shot, 'Tom&Jerry.png', 'p.png']) writeFileSync(join(root, 'img', name), PNG)
    const nul = String.fromCodePoint(0)
    writeFileSync(
      join(root, 'Shots.md'),
      [
        '# Shots',
        '',
        `![shot](img/${shot.replaceAll(' ', '%20')})`,
        '',
        '<img src="img/Tom&amp;Jerry.png" width="200">',
        '',
        `<img src="img/p.png" alt="${nul}">`,
        '',
      ].join('\n'),
    )
    const lib = library()
    const imported = await importFolder(lib, root, 'Notes')
    expect(imported.attachments).toBe(2)
    expect(imported.problems).toEqual([
      { path: 'Shots.md', image: 'img/p.png', code: 'E_IMPORT_IMAGE_UNLOCATED' },
    ])
    const [note] = await snapshot(lib)
    expect(note!.body).toContain('<img src="file:')
    expect(note!.body).toContain(`<img src="img/p.png" alt="${nul}">`)
    expect(note!.body).not.toContain('Screenshot')
  })
})
