import fc from 'fast-check'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clipTitle,
  createClock,
  createIdGenerator,
  createMirrorRunner,
  createMirrorTakeBack,
  createNoteService,
  createTagService,
  observeWrites,
  type MirrorRunner,
  emptyManifest,
  fileStem,
  markdownFile,
  NOTE_STATUSES,
  readBackCandidates,
  readMirrorFile,
  type MirrorManifest,
  type NoteStatus,
} from '../../src/core'
import { folderHost } from '../support/mirror-host'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// A file Devot wrote reads back as the note it was written from; an edited one gives the edit.

const ID_A = '0192a6f0-0000-7000-8000-000000000001'
const ID_B = '0192a6f0-0000-7000-8000-000000000002'
const NOTE = '0192a6f0-0000-7000-8000-000000000010'

const attachments = new Map([
  ['attachments/board.png', ID_A],
  ['attachments/my shot (1).png', ID_B],
])

const linkFor = (folderDepth: number) =>
  new Map([
    [ID_A, `${'../'.repeat(folderDepth)}attachments/board.png`],
    [ID_B, `${'../'.repeat(folderDepth)}attachments/my shot (1).png`],
  ])

describe('readMirrorFile', () => {
  it('reads Devot block, body and attachment links back', () => {
    const entry = {
      title: 'Plan',
      bodyMd: `Intro\n\n![board](devot://file/${ID_A}#half)\n\n<img src="devot://file/${ID_B}">\n`,
      tags: ['b', 'a'].sort(),
      status: 'on_hold' as NoteStatus,
    }
    const file = markdownFile(entry, 'Plan.md', linkFor(1))
    expect(file).toContain('../attachments/board.png#half')
    expect(readMirrorFile(file, 'Work/Plan.md', attachments)).toEqual(entry)
  })

  it('takes an edit made in another app', () => {
    const file = markdownFile(
      { title: 'Plan', bodyMd: '# Plan\n\nOne\n', tags: [], status: 'none' },
      'Plan.md',
      new Map(),
    )
    expect(file).toBe('# Plan\n\nOne\n')
    const edited =
      '---\n# Devot metadata\ntitle: Plan\ntags: [work]\nstatus: completed\n---\n# Plan\n\nOne\nTwo\r\n'
    expect(readMirrorFile(edited, 'Plan.md', attachments)).toEqual({
      title: 'Plan',
      bodyMd: '# Plan\n\nOne\nTwo\n',
      tags: ['work'],
      status: 'completed',
    })
  })

  it('follows a first heading changed outside Devot, and leaves unknown images as written', () => {
    const back = readMirrorFile('# Plans\n\n![x](../attachments/new.png)\n', 'Plan.md', attachments)
    expect(back.title).toBe('Plans')
    expect(back.bodyMd).toBe('# Plans\n\n![x](../attachments/new.png)\n')
  })

  const piece = fc.constantFrom(
    'a',
    'B',
    ' ',
    '#',
    '-',
    '---',
    ':',
    "'",
    '"',
    '[',
    ']',
    '(',
    ')',
    '!',
    '\n',
    '# Devot metadata',
    'title: x',
    `![i](devot://file/${ID_A})`,
    `![i](devot://file/${ID_B}#small)`,
    `<img src="devot://file/${ID_A}" alt=x>`,
    '`',
    '```\n',
  )
  const text = (max: number) => fc.array(piece, { maxLength: max }).map((p) => p.join(''))

  it('reads every file Devot writes back as its note', () => {
    fc.assert(
      fc.property(
        fc.record({
          title: text(5).map(clipTitle),
          bodyMd: text(12),
          tags: fc.uniqueArray(fc.constantFrom('work', 'home', 'a b', "it's"), {
            maxLength: 3,
          }),
          status: fc.constantFrom<NoteStatus>(...NOTE_STATUSES),
          depth: fc.integer({ min: 0, max: 2 }),
        }),
        ({ depth, ...entry }) => {
          const note = { ...entry, tags: [...entry.tags].sort() }
          const fileName = `${fileStem(note.title, 'Untitled')}.md`
          const path = [...Array.from({ length: depth }, () => 'Book'), fileName].join('/')
          const file = markdownFile(note, fileName, linkFor(depth))
          const back = readMirrorFile(file, path, attachments)
          expect(back).toEqual(note)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('readBackCandidates', () => {
  const manifest: MirrorManifest = {
    ...emptyManifest(),
    notes: {
      [NOTE]: {
        path: 'Plan.md',
        sha256: 'a'.repeat(64),
        size: 1,
        source: 's',
        files: [],
      },
      [ID_A]: {
        path: 'Other.md',
        sha256: 'b'.repeat(64),
        size: 1,
        source: 's',
        files: [],
      },
      [ID_B]: {
        path: 'Gone.md',
        sha256: 'c'.repeat(64),
        size: 1,
        source: 's',
        files: [],
      },
    },
  }

  it('lists notes whose file changed and that did not change in Devot', () => {
    const changed = new Map([
      ['Plan.md', 'd'.repeat(64)],
      ['Other.md', 'e'.repeat(64)],
      ['Gone.md', null],
    ])
    expect(readBackCandidates(manifest, changed, (id) => id !== ID_A)).toEqual([NOTE])
  })

  it('leaves files replaced by a folder or a link', () => {
    const changed = new Map<string, 'dir' | 'other'>([
      ['Plan.md', 'dir'],
      ['Other.md', 'other'],
    ])
    expect(readBackCandidates(manifest, changed, () => true)).toEqual([])
  })
})

const open: SqliteAdapter[] = []
const runners: MirrorRunner[] = []
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop()))
  open.splice(0).forEach((a) => a.close())
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])

function library(readBack = true) {
  const sqlite = openSqliteAdapter(join(tempDir('devot-read-back-db-'), 'db.sqlite'))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  let runner: MirrorRunner | undefined
  const storage = observeWrites(sqlite, (ids) => runner?.touch(ids))
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  // The worker's own services for what comes back, as the HTTP API has.
  const outside = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const root = tempDir('devot-read-back-out-')
  const host = folderHost(sqlite, root)
  host.setReadBack(readBack)
  const errors: string[] = []
  const changed: string[][] = []
  runner = createMirrorRunner({
    storage,
    host,
    untitled: 'Untitled',
    delayMs: 5,
    maxWaitMs: 50,
    onError: (code) => errors.push(code),
    takeBack: createMirrorTakeBack({
      notes: outside,
      tags,
      storage,
      before: () => notes.flush(),
      after: (ids) => changed.push([...ids]),
    }),
  })
  runners.push(runner)
  const settled = async () => {
    await notes.flush()
    await runner.idle()
  }
  return {
    sqlite,
    notes,
    tags,
    newId,
    root,
    host,
    runner,
    errors,
    changed,
    settled,
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
    write: (path: string, text: string) => writeFileSync(join(root, path), text),
    files: () =>
      readdirSync(root)
        .filter((name) => !name.startsWith('.'))
        .sort(),
    async start() {
      runner.reconcile()
      await settled()
    },
    async rescan() {
      runner.rescan()
      await settled()
    },
    body: async (id: string) => (await sqlite.getNote(id))!.bodyMd,
  }
}

describe('Bring Back Outside Edits', () => {
  it('takes a file edited in another app into its note, and keeps the file as it is', async () => {
    const lib = library()
    const id = await lib.notes.create('Plan', null)
    await lib.notes.setBody(id, '# Plan\n\nOne\n')
    await lib.notes.release(id)
    await lib.start()
    expect(lib.read('Plan.md')).toBe('# Plan\n\nOne\n')

    const edited =
      '---\n# Devot metadata\ntitle: Plan\ntags: [work]\nstatus: active\n---\n# Plan\n\nOne\nTwo\n'
    lib.write('Plan.md', edited)
    lib.host.clear()
    await lib.rescan()

    expect(await lib.body(id)).toBe('# Plan\n\nOne\nTwo\n')
    const [summary] = await lib.sqlite.listNotes()
    expect(summary!.status).toBe('active')
    expect((await lib.tags.list()).map((t) => t.name)).toEqual(['work'])
    // Written again only where Devot writes it its own way (quoted values).
    expect(lib.read('Plan.md')).toBe(
      edited.replace('title: Plan', "title: 'Plan'").replace('[work]', "['work']"),
    )
    expect(lib.files()).toEqual(['Plan.md'])
    expect(lib.host.log.kept).toEqual([])
    expect(lib.changed).toEqual([[id]])
    expect(lib.errors).toEqual([])

    // Devot's next edit is written over the file, which is Devot's again.
    await lib.notes.setBody(id, '# Plan\n\nOne\nTwo\nThree\n')
    await lib.settled()
    expect(lib.read('Plan.md')).toContain('Three')
    expect(lib.host.log.kept).toEqual([])
  })

  it('keeps attachments linked through an edit', async () => {
    const lib = library()
    const id = await lib.notes.create('Board', null)
    const fileId = lib.newId()
    await lib.sqlite.putFile({ id: fileId, noteId: id, name: 'board.png' }, PNG)
    await lib.notes.setBody(id, `# Board\n\n![b](devot://file/${fileId}#half)\n`)
    await lib.notes.release(id)
    await lib.start()
    expect(lib.read('Board.md')).toContain('](attachments/board.png#half)')

    lib.write('Board.md', `${lib.read('Board.md')}\nMore\n`)
    lib.host.clear()
    await lib.rescan()
    expect(lib.host.log.written).toEqual([])
    expect(await lib.body(id)).toBe(`# Board\n\n![b](devot://file/${fileId}#half)\n\nMore\n`)
    expect(lib.host.log.kept).toEqual([])
  })

  it('keeps the file aside when the note changed in Devot too', async () => {
    const lib = library()
    const id = await lib.notes.create('Plan', null)
    await lib.notes.setBody(id, '# Plan\n\nOne\n')
    await lib.start()
    lib.write('Plan.md', '# Plan\n\nOutside\n')
    await lib.notes.setBody(id, '# Plan\n\nInside\n')
    await lib.notes.flush()
    await lib.rescan()

    expect(await lib.body(id)).toBe('# Plan\n\nInside\n')
    expect(lib.read('Plan.md')).toBe('# Plan\n\nInside\n')
    expect(lib.read('Plan (edited outside Devot).md')).toBe('# Plan\n\nOutside\n')
    expect(lib.changed).toEqual([])
  })

  it('leaves the note alone when it is off, keeping the file aside as before', async () => {
    const lib = library(false)
    const id = await lib.notes.create('Plan', null)
    await lib.notes.setBody(id, '# Plan\n\nOne\n')
    await lib.notes.release(id)
    await lib.start()
    lib.write('Plan.md', '# Plan\n\nOutside\n')
    await lib.rescan()
    expect(lib.host.log.kept).toEqual([])
    lib.runner.reconcile()
    await lib.settled()
    expect(await lib.body(id)).toBe('# Plan\n\nOne\n')
    expect(lib.read('Plan (edited outside Devot).md')).toBe('# Plan\n\nOutside\n')
  })

  it('renames the file when its first heading changed, as for a title changed in Devot', async () => {
    const lib = library()
    const id = await lib.notes.create('Plan', null)
    await lib.notes.setBody(id, '# Plan\n\nOne\n')
    await lib.notes.release(id)
    await lib.start()
    lib.write('Plan.md', '# Roadmap\n\nOne\n')
    await lib.rescan()
    const [summary] = await lib.sqlite.listNotes()
    expect(summary!.title).toBe('Roadmap')
    expect(lib.files()).toEqual(['Roadmap.md'])
    expect(lib.read('Roadmap.md')).toBe('# Roadmap\n\nOne\n')
    expect(await lib.body(id)).toBe('# Roadmap\n\nOne\n')
  })

  it('writes nothing and reads no file when nothing changed', async () => {
    const lib = library()
    for (const title of ['A', 'B', 'C']) {
      const id = await lib.notes.create(title, null)
      await lib.notes.setBody(id, `# ${title}\n`)
      await lib.notes.release(id)
    }
    await lib.start()
    lib.host.clear()
    await lib.rescan()
    expect(lib.host.counts).toEqual({ hashed: 0, saved: 0 })
    expect(lib.host.log.written).toEqual([])
  })

  it('brings back an edit to a note that is open, through its document', async () => {
    const lib = library()
    const id = await lib.notes.create('Plan', null)
    await lib.notes.setBody(id, '# Plan\n\nOne\n')
    await lib.start()
    lib.write('Plan.md', '# Plan\n\nOne\nTwo\n')
    await lib.rescan()
    expect(await lib.body(id)).toBe('# Plan\n\nOne\nTwo\n')
    expect(lib.host.log.kept).toEqual([])
  })
})
