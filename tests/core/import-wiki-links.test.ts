import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  importMarkdown,
  nearestImageSize,
  noteUri,
  parseWikiTarget,
  type ImportScan,
  type ImportSource,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const FIXTURE = join(__dirname, 'fixtures', 'wiki-import')

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

async function setup() {
  const sqlite = openSqliteAdapter(join(tempDir('devot-wiki-import-'), 'db.sqlite'))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const services = {
    notes: createNoteService({ storage: sqlite, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage: sqlite, clock, newId }),
    tags: createTagService({ storage: sqlite, clock, newId }),
    newId,
  }
  return { sqlite, services }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/** The fixture folder as Rust would scan and read it. */
function fixtureFolder(sqlite: SqliteAdapter): { scan: ImportScan; source: ImportSource } {
  const paths = walk(FIXTURE)
    .map((file) => relative(FIXTURE, file).split(sep).join('/'))
    .sort()
  const item = (path: string) => ({ path, bytes: 1 })
  const scan: ImportScan = {
    id: 1,
    name: 'Vault',
    kind: 'folder',
    files: paths.filter((p) => p.endsWith('.md')).map(item),
    images: paths.filter((p) => p.endsWith('.png')).map(item),
    skipped: [],
  }
  const source: ImportSource = {
    read: async (path) => readFileSync(join(FIXTURE, path), 'utf8'),
    attach: async (path, file) => {
      const data = new Uint8Array(readFileSync(join(FIXTURE, path)))
      await sqlite.putFile({ ...file, name: path.split('/').pop()! }, data)
    },
  }
  return { scan, source }
}

const memorySource = (files: Record<string, string>): ImportSource => ({
  read: async (path) => files[path]!,
  attach: async () => {
    throw new Error('E_TEST_NO_IMAGES')
  },
})

const memoryScan = (files: Record<string, string>): ImportScan => ({
  id: 1,
  name: 'Vault',
  kind: 'folder',
  files: Object.keys(files)
    .sort()
    .map((path) => ({ path, bytes: 1 })),
  images: [],
  skipped: [],
})

const link = (text: string, id: string) => `[${text}](${noteUri(id)})`

describe('importing wiki-style links', () => {
  async function importFixture(wikiLinks = true) {
    const { sqlite, services } = await setup()
    const existing = await services.notes.create('Existing Note')
    await services.notes.release(existing)
    const { scan, source } = fixtureFolder(sqlite)
    const report = await importMarkdown({ ...services, scan, source, wikiLinks })
    const body = async (path: string) => (await sqlite.getNote(report.noteIds[path]!))!.bodyMd
    return { sqlite, services, report, existing, body }
  }

  it('links A to B, and B lists A in its backlinks', async () => {
    const { services, report, body } = await importFixture()
    const alpha = report.noteIds['Alpha.md']!
    const beta = report.noteIds['Notes/Beta.md']!
    const text = await body('Alpha.md')
    expect(text).toContain(
      `See ${link('Beta', beta)}, ${link('the second note', beta)} and ${link('Beta#Plan', beta)}.`,
    )
    expect(await body('Notes/Beta.md')).toContain(`Back to ${link('Alpha', alpha)} and`)
    expect((await services.notes.backlinks(beta)).map((n) => n.id)).toEqual([alpha])
    expect((await services.notes.backlinks(alpha)).map((n) => n.id)).toEqual([beta])
  })

  it('keeps a heading of the same note as shown text on a link to that note', async () => {
    const { report, body } = await importFixture()
    const beta = report.noteIds['Notes/Beta.md']!
    expect(await body('Notes/Beta.md')).toContain(` and ${link('#Plan', beta)}.`)
  })

  it('leaves links in inline code, fenced code and escaped brackets alone', async () => {
    const { body } = await importFixture()
    const text = await body('Alpha.md')
    expect(text).toContain('Inline `[[Beta]]` stays')
    expect(text).toContain('```\n[[Beta]]\n```')
    expect(await body('Notes/Beta.md')).toContain('Escaped \\[[Alpha]] stays.')
  })

  it('leaves links it cannot match as written and counts them', async () => {
    const { report, body } = await importFixture()
    expect(await body('Alpha.md')).toContain('Missing: [[Nowhere]] and ![[missing.png]].')
    expect(report.unresolvedLinks).toBe(2)
    expect(report.links).toBe(9)
  })

  it('attaches an embedded image of the folder at the nearest size preset', async () => {
    const { sqlite, report, body } = await importFixture()
    const alpha = report.noteIds['Alpha.md']!
    const files = sqlite.db.prepare('SELECT id, note_id AS noteId, name FROM files').all() as {
      id: string
      noteId: string
      name: string
    }[]
    expect(files).toEqual([{ id: expect.any(String), noteId: alpha, name: 'diagram.png' }])
    expect(await body('Alpha.md')).toContain(`\n![w:240](devot://file/${files[0]!.id})\n`)
    expect(report.attachments).toBe(1)
  })

  it('matches titles without case or diacritics, and notes already in the library', async () => {
    const { report, existing, body } = await importFixture()
    const resume = report.noteIds['Resume.md']!
    const decomposed = 'Résumé 2024'
    expect(await body('Alpha.md')).toContain(
      `Also ${link(decomposed, resume)} and ${link('RESUME 2024', resume)}.`,
    )
    expect(await body('Resume.md')).toContain(`Lists ${link('Existing Note', existing)}.`)
  })

  it('keeps every wiki link as written when turned off', async () => {
    const { report, body } = await importFixture(false)
    const original = readFileSync(join(FIXTURE, 'Alpha.md'), 'utf8')
    expect(await body('Alpha.md')).toBe(original)
    expect(report).toMatchObject({ links: 0, unresolvedLinks: 0, attachments: 0 })
  })

  it('uses a folder prefix only to choose between notes of the same name', async () => {
    const { sqlite, services } = await setup()
    const files = {
      'A/Same.md': 'One\n',
      'B/Same.md': 'Two\n',
      'Index.md': '[[B/Same]] [[Other/Same]] [[same.md]]\n',
      'A/Near.md': '[[Same]]\n',
    }
    const report = await importMarkdown({
      ...services,
      scan: memoryScan(files),
      source: memorySource(files),
    })
    const id = (path: string) => report.noteIds[path]!
    const body = async (path: string) => (await sqlite.getNote(id(path)))!.bodyMd
    expect(await body('Index.md')).toBe(
      `${link('Same', id('B/Same.md'))} ${link('Same', id('A/Same.md'))} ${link('same', id('A/Same.md'))}\n`,
    )
    expect(await body('A/Near.md')).toBe(`${link('Same', id('A/Same.md'))}\n`)
  })

  it('escapes shown text that would read as formatting, and splits on a table pipe', async () => {
    const { sqlite, services } = await setup()
    const files = {
      'Target.md': '# Target\n',
      'Table.md': '| a |\n|---|\n| [[Target\\|*bold* text]] |\n',
    }
    const report = await importMarkdown({
      ...services,
      scan: memoryScan(files),
      source: memorySource(files),
    })
    const text = (await sqlite.getNote(report.noteIds['Table.md']!))!.bodyMd
    expect(text).toBe(
      `| a |\n|---|\n| [\\*bold\\* text](${noteUri(report.noteIds['Target.md']!)}) |\n`,
    )
  })
})

describe('parseWikiTarget', () => {
  it('reads path, heading, alias and an embed width', () => {
    expect(parseWikiTarget('folder/Title.md#Part|Shown', false)).toEqual({
      path: 'folder/Title',
      name: 'Title',
      heading: 'Part',
      alias: 'Shown',
      width: null,
    })
    expect(parseWikiTarget('pic.png|300x200', true)).toMatchObject({ name: 'pic.png', width: 300 })
    expect(parseWikiTarget('Note|300', false)).toMatchObject({ alias: '300', width: null })
  })
})

describe('nearestImageSize', () => {
  it('takes the preset nearest a width in pixels', () => {
    expect([null, 100, 300, 400, 600, 2000].map(nearestImageSize)).toEqual([
      'auto',
      'small',
      'small',
      'half',
      'full',
      'full',
    ])
  })
})
