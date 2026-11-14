import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBookTree,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  importLayout,
  importMarkdown,
  importTree,
  sourceAppOf,
  type BookNode,
  type ImportFolder,
  type ImportScan,
  type ImportSource,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Folders other apps export: Notion's Markdown export and Bear's TextBundles.

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const ID_A = '1a2b3c4d5e6f708192a3b4c5d6e7f801'
const ID_B = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const ID_C = 'aaaabbbbccccddddeeeeffff00001111'

async function run(files: Record<string, string>, images: Record<string, Uint8Array> = {}) {
  const sqlite = openSqliteAdapter(join(tempDir('devot-import-apps-'), 'db.sqlite'))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const services = {
    notes: createNoteService({ storage: sqlite, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage: sqlite, clock, newId }),
    tags: createTagService({ storage: sqlite, clock, newId }),
  }
  const scan: ImportScan = {
    id: 1,
    name: 'Export',
    kind: 'folder',
    files: Object.keys(files)
      .sort()
      .map((path) => ({ path, bytes: 1 })),
    images: Object.keys(images)
      .sort()
      .map((path) => ({ path, bytes: 1 })),
    skipped: [],
  }
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
    },
  }
  const report = await importMarkdown({ ...services, newId, scan, source })
  const books = await sqlite.listBooks()
  const tagNames = new Map((await sqlite.listTags()).map((t) => [t.id, t.name]))
  const notes = await Promise.all(
    (await sqlite.listNotes()).map(async (summary) => ({
      title: summary.title,
      book: books.find((b) => b.id === summary.bookId)?.name ?? null,
      tags: summary.tagIds.map((id) => tagNames.get(id)).sort(),
      body: (await sqlite.getNote(summary.id))!.bodyMd,
      id: summary.id,
    })),
  )
  const names = (nodes: BookNode[]): unknown[] =>
    nodes.map((n) => (n.children.length ? [n.name, names(n.children)] : n.name))
  return {
    report,
    notes,
    note: (title: string) => notes.find((n) => n.title === title)!,
    tree: names(buildBookTree(books)),
    preview: importTree(scan),
  }
}

/** The notebooks the sheet shows (folders of images alone show too, but make none). */
const shape = (folder: ImportFolder): unknown => {
  const books = folder.folders.filter((f) => f.notebook)
  return {
    name: folder.name,
    notes: folder.notes,
    ...(books.length ? { folders: books.map(shape) } : {}),
  }
}

describe('which app made a folder', () => {
  it('tells Notion by its page IDs and Bear by its TextBundles', () => {
    expect(sourceAppOf([`Plan ${ID_A}.md`, `Plan ${ID_A}/Sub ${ID_B}.md`, 'Notes.md'])).toBe(
      'notion',
    )
    expect(sourceAppOf(['Notes.md', 'Other.md', `Plan ${ID_A}.md`])).toBeNull()
    expect(sourceAppOf(['Plan.textbundle/text.markdown', 'Other.md'])).toBe('bear')
    expect(sourceAppOf(['Plan.md', 'Work/Other.md'])).toBeNull()
    expect(sourceAppOf([])).toBeNull()
  })

  it('leaves any other folder as it is laid out', () => {
    const layout = importLayout('folder', [{ path: 'Work/Plan.md', bytes: 1 }])
    expect(layout.app).toBeNull()
    expect(layout.noteFolder('Work/Plan.md')).toBe('Work')
    expect(layout.folderName('Work')).toBe('Work')
  })
})

describe('Notion import', () => {
  const files = {
    [`Projects ${ID_A}.md`]: `# Projects\n\nSee [Roadmap](Projects%20${ID_A}/Roadmap%20${ID_B}.md) and [the wiki](https://example.com/a.md).\n`,
    [`Projects ${ID_A}/Roadmap ${ID_B}.md`]: `# Roadmap\n\n![chart](Roadmap%20${ID_B}/chart.png)\n\nBack to [Projects](../Projects%20${ID_A}.md).\n`,
    [`Projects ${ID_A}/Untitled ${ID_C}.md`]: 'No heading here.\n',
    'Inbox.md': `# Inbox\n\n[Roadmap][r]\n\n[r]: Projects%20${ID_A}/Roadmap%20${ID_B}.md\n`,
  }
  const images = { [`Projects ${ID_A}/Roadmap ${ID_B}/chart.png`]: PNG }

  it('leaves page IDs out of names and puts a page with subpages into their notebook', async () => {
    const lib = await run(files, images)
    expect(lib.report.problems).toEqual([])
    expect(lib.tree).toEqual(['Projects'])
    expect(lib.notes.map((n) => [n.title, n.book]).sort()).toEqual([
      ['Inbox', null],
      ['Projects', 'Projects'],
      ['Roadmap', 'Projects'],
      ['Untitled', 'Projects'],
    ])
    expect(shape(lib.preview)).toEqual({
      name: 'Export',
      notes: 4,
      folders: [{ name: 'Projects', notes: 3 }],
    })
  })

  it('turns links between pages into note links and keeps images', async () => {
    const lib = await run(files, images)
    const roadmap = lib.note('Roadmap')
    const projects = lib.note('Projects')
    expect(projects.body).toBe(
      `# Projects\n\nSee [Roadmap](devot://note/${roadmap.id}) and [the wiki](https://example.com/a.md).\n`,
    )
    expect(roadmap.body).toMatch(/!\[chart\]\(devot:\/\/file\/[0-9a-f-]+\)/)
    expect(roadmap.body).toContain(`[Projects](devot://note/${projects.id})`)
    expect(lib.note('Inbox').body).toContain(`[r]: devot://note/${roadmap.id}`)
  })
})

describe('Bear import', () => {
  const files = {
    'Plan.textbundle/text.markdown':
      '# Plan\n\nShip it #work #work/q3 and #multi word tag# soon.\n\n![](assets/shot.png)\n\n`#not` and [#nolink](https://x.y)\n',
    'Ideas/Loose.textbundle/text.md': 'Just text, #idea.\n',
    'Ideas/Plain.md': '# Plain\n\n#ignored-outside-bear-bundles-is-fine\n',
  }
  const images = { 'Plan.textbundle/assets/shot.png': PNG }

  it('imports each TextBundle as one note, with its images and tags', async () => {
    const lib = await run(files, images)
    expect(lib.report.problems).toEqual([])
    expect(lib.tree).toEqual(['Ideas'])
    const plan = lib.note('Plan')
    expect(plan.book).toBeNull()
    expect(plan.tags).toEqual(['multi word tag', 'work', 'work/q3'])
    expect(plan.body).toMatch(/!\[\]\(devot:\/\/file\/[0-9a-f-]+\)/)
    const loose = lib.note('Loose')
    expect(loose.book).toBe('Ideas')
    expect(loose.tags).toEqual(['idea'])
    expect(shape(lib.preview)).toEqual({
      name: 'Export',
      notes: 3,
      folders: [{ name: 'Ideas', notes: 2 }],
    })
  })
})
