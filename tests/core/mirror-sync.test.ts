import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBatch,
  createBookService,
  createClock,
  createIdGenerator,
  createMirrorRunner,
  createNoteService,
  createTagService,
  createTemplateService,
  importMarkdown,
  observeWrites,
  sha256Hex,
  TEMPLATES_BOOK_ID,
  type ImportScan,
  type ImportSource,
  type MirrorRunner,
  type NoteStatus,
} from '../../src/core'
import { folderHost, MANIFEST } from '../support/mirror-host'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// The mirror end to end on real SQLite and a real folder, with a stand-in for Rust
// (tests/support/mirror-host.ts) running the planned operations with Rust's checks.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 2])

const open: SqliteAdapter[] = []
const runners: MirrorRunner[] = []
afterEach(() => {
  runners.splice(0).forEach((r) => r.stop())
  open.splice(0).forEach((a) => a.close())
})

function library(options: { root?: string; dbPath?: string } = {}) {
  const sqlite = openSqliteAdapter(options.dbPath ?? join(tempDir('devot-mirror-db-'), 'db.sqlite'))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  let runner: MirrorRunner | undefined
  const storage = observeWrites(sqlite, () => runner?.touch())
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  const root = options.root ?? tempDir('devot-mirror-out-')
  const host = folderHost(sqlite, root)
  const errors: string[] = []
  runner = createMirrorRunner({
    storage,
    host,
    untitled: 'Untitled',
    delayMs: 5,
    maxWaitMs: 50,
    retryMs: 20,
    onError: (code) => errors.push(code),
  })
  runners.push(runner)
  const lib = { sqlite, newId, notes, books, tags, templates, root, host, runner, errors }
  return {
    ...lib,
    async settled() {
      await notes.flush()
      await runner.idle()
    },
    async note(
      title: string,
      bookId: string | null,
      body: string,
      more: { tags?: string[]; status?: NoteStatus } = {},
    ) {
      const noteId = await notes.create(title, bookId)
      await notes.setBody(noteId, body)
      for (const name of more.tags ?? []) await tags.addToNote(noteId, name)
      if (more.status) await notes.setStatus(noteId, more.status)
      await notes.release(noteId)
      return noteId
    },
    async image(noteId: string, name: string, bytes: Uint8Array) {
      const fileId = newId()
      await sqlite.putFile({ id: fileId, noteId, name }, bytes)
      return fileId
    },
  }
}

type Library = ReturnType<typeof library>

function walk(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel))
    .sort()
    .flatMap((name) => {
      const path = rel ? `${rel}/${name}` : name
      if (path === MANIFEST) return []
      return statSync(join(root, path)).isDirectory() ? walk(root, path) : [path]
    })
}

const readIn = (root: string, path: string) => readFileSync(join(root, path), 'utf8')
const read = (lib: Library, path: string) => readIn(lib.root, path)

async function until(holds: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!holds()) {
    if (Date.now() > end) throw new Error('E_TEST_TIMEOUT')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A small library: nested notebooks, a tag, a status, an image, a template and the Trash. */
async function sample() {
  const lib = library()
  const work = await lib.books.create('Work', null)
  const plans = await lib.books.create('Plans', work)
  const inbox = await lib.note('Inbox', work, '# Inbox\n\nLoose thoughts.\n')
  const plan = await lib.note('Launch', plans, 'Draft\n', { tags: ['q4'], status: 'active' })
  const board = await lib.image(plan, 'board.png', PNG)
  await lib.notes.setBody(plan, `Draft\n\n![Board](devot://file/${board}#half)\n`)
  await lib.notes.release(plan)
  const loose = await lib.note('Loose', null, 'At the top.\n')
  const template = await lib.templates.create('Weekly')
  await lib.notes.setBody(template, 'Template body.\n')
  await lib.notes.release(template)
  const gone = await lib.note('Gone', work, 'In the Trash.\n')
  await lib.notes.trash(gone)
  return { ...lib, ids: { work, plans, inbox, plan, board, loose, template, gone } }
}

async function mirrorOn(lib: Library) {
  lib.runner.reconcile()
  await lib.settled()
  lib.host.clear()
}

describe('turning the mirror on', () => {
  it('writes every note like an export of every notebook; templates and the Trash stay out', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    expect(walk(lib.root)).toEqual([
      'Loose.md',
      'Work/Inbox.md',
      'Work/Plans/Launch.md',
      'attachments/board.png',
    ])
    expect(read(lib, 'Work/Inbox.md')).toBe('# Inbox\n\nLoose thoughts.\n')
    expect(read(lib, 'Work/Plans/Launch.md')).toBe(
      [
        '---',
        '# Devot metadata',
        "title: 'Launch'",
        "tags: ['q4']",
        'status: active',
        '---',
        'Draft',
        '',
        '![Board](../../attachments/board.png#half)',
        '',
      ].join('\n'),
    )
    expect(readFileSync(join(lib.root, 'attachments/board.png'))).toEqual(Buffer.from(PNG))
    const manifest = lib.host.manifest()
    expect(Object.keys(manifest.notes).sort()).toEqual(
      [lib.ids.inbox, lib.ids.plan, lib.ids.loose].sort(),
    )
    for (const entry of Object.values(manifest.notes)) {
      expect(entry.sha256).toBe(sha256Hex(read(lib, entry.path)))
    }
    expect(lib.host.size()).toBe(
      walk(lib.root).reduce((sum, p) => sum + statSync(join(lib.root, p)).size, 0),
    )
    expect(lib.errors).toEqual([])
  })
})

describe('keeping the folder up to date', () => {
  it('reflects each change, touching only the files it affects', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    const { ids } = lib
    const log = lib.host.log
    const step = async (change: () => Promise<unknown>) => {
      lib.host.clear()
      await change()
      await lib.settled()
      return structuredClone(log)
    }

    const edit = await step(async () => {
      await lib.notes.setBody(ids.inbox, '# Inbox\n\nNew thoughts.\n')
    })
    expect(edit).toEqual({ written: ['Work/Inbox.md'], moved: [], removed: [], kept: [] })
    expect(read(lib, 'Work/Inbox.md')).toBe('# Inbox\n\nNew thoughts.\n')

    // Pinning changes nothing in the file.
    const pin = await step(() => lib.notes.setPinned(ids.loose, true))
    expect(pin).toEqual({ written: [], moved: [], removed: [], kept: [] })

    // Renaming moves the file (its heading keeps saying the old title).
    const rename = await step(() => lib.notes.setTitle(ids.inbox, 'Inbox 2026'))
    expect(rename.moved).toEqual([['Work/Inbox.md', 'Work/Inbox 2026.md']])
    expect(rename.written).toEqual(['Work/Inbox 2026.md'])
    expect(read(lib, 'Work/Inbox 2026.md')).toContain("title: 'Inbox 2026'")

    const move = await step(() => lib.notes.setBook(ids.plan, ids.work))
    expect(move.moved).toEqual([['Work/Plans/Launch.md', 'Work/Launch.md']])
    expect(read(lib, 'Work/Launch.md')).toContain('](../attachments/board.png#half)')
    expect(existsSync(join(lib.root, 'Work/Plans'))).toBe(false)

    const retag = await step(() => lib.tags.addToNote(ids.loose, 'misc'))
    expect(retag.written).toEqual(['Loose.md'])
    expect(read(lib, 'Loose.md')).toContain("tags: ['misc']")
    const status = await step(() => lib.notes.setStatus(ids.loose, 'on_hold'))
    expect(status.written).toEqual(['Loose.md'])
    expect(read(lib, 'Loose.md')).toContain('status: on-hold')

    const trash = await step(() => lib.notes.trash(ids.loose))
    expect(trash).toEqual({ written: [], moved: [], removed: ['Loose.md'], kept: [] })
    const restore = await step(() => lib.notes.restore(ids.loose))
    expect(restore.written).toEqual(['Loose.md'])

    const renameBook = await step(() => lib.books.rename(ids.work, 'Job'))
    expect(renameBook.moved.sort()).toEqual([
      ['Work/Inbox 2026.md', 'Job/Inbox 2026.md'],
      ['Work/Launch.md', 'Job/Launch.md'],
    ])
    const sub = await lib.books.create('Sub', null)
    const moveBook = await step(() => lib.books.move(ids.work, sub))
    expect(moveBook.moved.sort()).toEqual([
      ['Job/Inbox 2026.md', 'Sub/Job/Inbox 2026.md'],
      ['Job/Launch.md', 'Sub/Job/Launch.md'],
    ])
    expect(read(lib, 'Sub/Job/Launch.md')).toContain('](../../attachments/board.png#half)')
    const removeBook = await step(() => lib.books.remove(sub))
    expect(removeBook.moved.sort()).toEqual([
      ['Sub/Job/Inbox 2026.md', 'Inbox 2026.md'],
      ['Sub/Job/Launch.md', 'Launch.md'],
    ])
    expect(walk(lib.root)).toEqual([
      'Inbox 2026.md',
      'Launch.md',
      'Loose.md',
      'attachments/board.png',
    ])
    expect(lib.errors).toEqual([])
  })

  it('follows batch actions, duplicates, new notes from a selection or a template, and purges', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    const { ids } = lib
    await applyBatch({ notes: lib.notes, tags: lib.tags }, [ids.inbox, ids.loose], {
      kind: 'status',
      status: 'completed',
    })
    await lib.settled()
    expect(lib.host.log.written.sort()).toEqual(['Loose.md', 'Work/Inbox.md'])
    expect(read(lib, 'Loose.md')).toContain('status: completed')

    lib.host.clear()
    const copy = await lib.notes.duplicate(ids.plan)
    const extracted = await lib.notes.extract(ids.inbox, 'Picked text\n')
    await lib.notes.setBody(ids.template, '---\nnotebook: Work\n---\nFrom a template.\n')
    const fromTemplate = await lib.templates.apply(ids.template, { now: Date.now() }, null)
    await lib.settled()
    const manifest = lib.host.manifest()
    expect(manifest.notes[copy]?.path).toBe('Work/Plans/Launch 2.md')
    expect(manifest.notes[extracted.id]?.path).toBe('Work/Picked text.md')
    expect(manifest.notes[fromTemplate]?.path).toBe('Work/Weekly.md')
    // The duplicate shows its own copy of the image, so two copies now.
    expect(walk(lib.root).filter((p) => p.startsWith('attachments/'))).toEqual([
      'attachments/board 2.png',
      'attachments/board.png',
    ])
    expect(Object.values(manifest.notes).every((e) => !e.path.startsWith('Templates'))).toBe(true)

    // Purging the original deletes its image from the database: its copy goes.
    lib.host.clear()
    await lib.notes.trash(ids.plan)
    await lib.notes.purge(ids.plan)
    await lib.settled()
    expect(lib.host.log.removed.sort()).toEqual(['Work/Plans/Launch.md', 'attachments/board.png'])
    expect(lib.errors).toEqual([])
  })

  it('a pass waits for saves to pause and comes once for many of them', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    let opens = 0
    const openFolder = lib.host.open.bind(lib.host)
    lib.host.open = (known) => {
      opens += 1
      return openFolder(known)
    }
    // As in the app: a pass a second after the last save; its steps yield without a timer, so only its wait is on the clock.
    const runner = createMirrorRunner({
      storage: lib.sqlite,
      host: lib.host,
      untitled: 'Untitled',
      delayMs: 1000,
      yieldNow: () => Promise.resolve(),
    })
    runners.push(runner)
    lib.runner.stop()
    runner.reconcile()
    await runner.idle()
    opens = 0
    // The test's clock: saves 900 ms apart never leave the second the pass waits for.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      for (let i = 0; i < 5; i += 1) {
        await lib.notes.setBody(lib.ids.inbox, `# Inbox\n\nTyping ${i}.\n`)
        await lib.notes.flush()
        runner.touch()
        await vi.advanceTimersByTimeAsync(900)
        expect(opens).toBe(0)
      }
      await vi.advanceTimersByTimeAsync(100)
      expect(opens).toBe(1)
    } finally {
      vi.useRealTimers()
    }
    await runner.idle()
    expect(opens).toBe(1)
    expect(lib.host.log.written).toEqual(['Work/Inbox.md'])
    expect(read(lib, 'Work/Inbox.md')).toContain('Typing 4.')
  })
})

describe('following the database', () => {
  it('starts a pass after writes the mirror follows, never after reads or history', async () => {
    const sqlite = openSqliteAdapter(join(tempDir('devot-mirror-db-'), 'db.sqlite'))
    open.push(sqlite)
    let changes = 0
    const storage = observeWrites(sqlite, () => (changes += 1))
    const clock = createClock('mac1')
    const newId = createIdGenerator()
    const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
    const tags = createTagService({ storage, clock, newId })
    const books = createBookService({ storage, clock, newId })
    const id = await notes.create('One', null)
    expect(changes).toBe(1)
    await notes.list()
    await notes.search('One')
    await books.list()
    await tags.list()
    await notes.history(id)
    await sqlite.listActivity(0)
    expect(changes).toBe(1)
    await tags.addToNote(id, 'a')
    await books.create('Book', null)
    expect(changes).toBeGreaterThanOrEqual(3)
  })
})

describe('reconciling once per generation', () => {
  it('a reconcile for the generation a full pass ran for (a resume) runs nothing more', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    let opens = 0
    const openFolder = lib.host.open.bind(lib.host)
    lib.host.open = (known) => {
      opens += 1
      return openFolder(known)
    }
    const { generation } = await openFolder(null)
    lib.runner.reconcile(generation)
    await lib.runner.idle()
    expect(opens).toBe(0)
    lib.runner.reconcile(generation + 1)
    await lib.runner.idle()
    expect(opens).toBe(1)
    lib.runner.reconcile()
    await lib.runner.idle()
    expect(opens).toBe(2)
  })
})

describe('something always in the way', () => {
  it('a conflict that never clears is tried a few times, then waits for the next pass', async () => {
    const lib = await sample()
    let applies = 0
    const apply = lib.host.apply.bind(lib.host)
    lib.host.apply = async (generation, ops) => {
      applies += 1
      return Promise.all(
        ops.map(async (op) =>
          op.kind === 'note'
            ? { code: 'E_MIRROR_EXISTS', path: op.path, state: `${applies}`.padStart(64, '0') }
            : (await apply(generation, [op]))[0]!,
        ),
      )
    }
    lib.runner.reconcile()
    await lib.runner.idle()
    expect(applies).toBeLessThanOrEqual(12)
    expect(lib.errors.filter((c) => c === 'E_MIRROR_EXISTS').length).toBeGreaterThan(0)
  })
})

describe('out of date', () => {
  it('an operation planned from an older manifest waits for the next pass, without looping', async () => {
    const lib = await sample()
    let opens = 0
    const openFolder = lib.host.open.bind(lib.host)
    lib.host.open = (known) => {
      opens += 1
      return openFolder(known)
    }
    const apply = lib.host.apply.bind(lib.host)
    lib.host.apply = async (generation, ops) => {
      const results = await apply(
        generation,
        ops.filter((op) => op.kind !== 'file'),
      )
      // Every attachment's operation finds Rust's manifest moved on.
      return ops.map((op) => (op.kind === 'file' ? { code: 'E_MIRROR_STALE' } : results.shift()!))
    }
    lib.runner.reconcile()
    await lib.runner.idle()
    expect(opens).toBe(1)
    expect(walk(lib.root)).toEqual(['Loose.md', 'Work/Inbox.md', 'Work/Plans/Launch.md'])
  })

  it('after a stop during a batch, the next pass reads the manifest again', async () => {
    const lib = await sample()
    const known: (number | null)[] = []
    const openFolder = lib.host.open.bind(lib.host)
    lib.host.open = (k) => {
      known.push(k)
      return openFolder(k)
    }
    let stopped: Promise<void> | undefined
    const apply = lib.host.apply.bind(lib.host)
    lib.host.apply = async (generation, ops) => {
      const results = await apply(generation, ops)
      // Rust ran the batch; the pass stops before it hears the results.
      stopped ??= lib.runner.stop()
      return results
    }
    lib.runner.reconcile()
    await until(() => stopped !== undefined)
    await stopped
    lib.host.apply = apply
    const { generation } = await openFolder(null)
    lib.runner.reconcile(generation)
    await lib.runner.idle()
    expect(known.at(-1)).toBe(null)
    expect(walk(lib.root)).toEqual([
      'Loose.md',
      'Work/Inbox.md',
      'Work/Plans/Launch.md',
      'attachments/board.png',
    ])
  })

  it('a resume runs one full pass, even when the window asks for one meanwhile', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    let full = 0
    const check = lib.host.check.bind(lib.host)
    lib.host.check = (generation, paths) => {
      if (paths === null) full += 1
      return check(generation, paths)
    }
    const openFolder = lib.host.open.bind(lib.host)
    lib.host.open = async (k) => {
      const opened = await openFolder(k)
      // The window hears of the new generation while the pass runs.
      lib.runner.reconcile(opened.generation)
      return opened
    }
    const away = join(tempDir('devot-mirror-away-'), 'mirror')
    renameSync(lib.root, away)
    lib.runner.touch()
    await lib.notes.setBody(lib.ids.loose, 'Changed.\n')
    await lib.notes.flush()
    await until(() => lib.host.paused() !== null)
    renameSync(away, lib.root)
    full = 0
    lib.runner.wake()
    await until(() => lib.host.paused() === null && read(lib, 'Loose.md') === 'Changed.\n')
    await lib.runner.idle()
    expect(full).toBe(1)
  })
})

describe('stopping', () => {
  it('ends a pass after the batch it is in (quitting, turning off); the manifest lists every file', async () => {
    const lib = library()
    // More notes than one batch of operations (200).
    for (let i = 0; i < 260; i += 1) await lib.note(`Note ${i}`, null, `Body ${i}.\n`)
    let batches = 0
    let stopped: Promise<void> | undefined
    const apply = lib.host.apply.bind(lib.host)
    lib.host.apply = async (generation, ops) => {
      batches += 1
      const results = await apply(generation, ops)
      stopped ??= lib.runner.stop()
      return results
    }
    lib.runner.reconcile()
    await until(() => stopped !== undefined)
    await stopped
    expect(batches).toBe(1)
    const listed = Object.values(lib.host.manifest().notes).map((e) => e.path)
    expect(listed).toHaveLength(200)
    expect(walk(lib.root)).toEqual(listed.sort())
    await lib.notes.setBody((await lib.notes.list())[0]!.id, 'Changed.\n')
    await lib.settled()
    expect(batches).toBe(1)
    // 260 notes and 200 files outrun the default 5 s on a busy CI runner.
  }, 30_000)
})

describe('files Devot did not write', () => {
  it('are never changed or deleted, whatever their names', async () => {
    const lib = await sample()
    const theirs = {
      'Loose.md': 'their own Loose\n',
      'Work/notes.txt': 'their notes\n',
      'attachments/board.png': 'their image',
      'Work/Plans/Launch.md': 'their launch\n',
    }
    for (const [path, text] of Object.entries(theirs)) {
      mkdirSync(join(lib.root, path, '..'), { recursive: true })
      writeFileSync(join(lib.root, path), text)
    }
    // A non-empty folder without a manifest is used once confirmed (Rust writes an empty manifest then).
    writeFileSync(
      join(lib.root, MANIFEST),
      JSON.stringify({ version: 1, notes: {}, files: {}, books: {} }),
    )
    await mirrorOn(lib)
    expect(walk(lib.root)).toEqual([
      'Loose 2.md',
      'Loose.md',
      'Work/Inbox.md',
      'Work/Plans/Launch 2.md',
      'Work/Plans/Launch.md',
      'Work/notes.txt',
      'attachments/board 2.png',
      'attachments/board.png',
    ])
    expect(read(lib, 'Work/Plans/Launch 2.md')).toContain('](../../attachments/board%202.png#half)')
    await lib.notes.setTitle(lib.ids.loose, 'Moved away')
    await lib.notes.trash(lib.ids.plan)
    await lib.settled()
    lib.runner.reconcile()
    await lib.settled()
    for (const [path, text] of Object.entries(theirs)) expect(read(lib, path)).toBe(text)
    expect(lib.host.log.kept).toEqual([])
  })
})

describe('files the manifest does not list', () => {
  it('a batch whose manifest was never saved: its files are taken back, nothing is written twice', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    lib.runner.stop()
    // The process ended after the batch wrote its files, before the manifest listing them was saved.
    const files = walk(lib.root)
    const bytes = files.map((path) => readFileSync(join(lib.root, path)))
    writeFileSync(
      join(lib.root, MANIFEST),
      JSON.stringify({ version: 1, notes: {}, files: {}, books: {} }),
    )
    lib.host.setFolder(lib.root)
    lib.runner.reconcile()
    await lib.settled()
    expect(walk(lib.root)).toEqual(files)
    expect(files.map((path) => readFileSync(join(lib.root, path)))).toEqual(bytes)
    expect(lib.host.log).toEqual({ written: [], moved: [], removed: [], kept: [] })
    const manifest = lib.host.manifest()
    expect(
      Object.values(manifest.notes)
        .map((e) => e.path)
        .sort(),
    ).toEqual(['Loose.md', 'Work/Inbox.md', 'Work/Plans/Launch.md'])
    expect(manifest.files[lib.ids.board]?.path).toBe('attachments/board.png')
    expect(lib.errors).toEqual([])
    const fresh = library()
    const report = await importFolder(fresh, lib.root, 'Mirror')
    expect(report.problems).toEqual([])
    const expected = (await snapshot(lib)).map((n) => ({
      ...n,
      book: n.book ? `Mirror/${n.book}` : 'Mirror',
    }))
    expect(await snapshot(fresh)).toEqual(expected)
  })

  it('a deleted manifest pauses the mirror until its folder is chosen again; then nothing is written twice', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    lib.runner.stop()
    const files = walk(lib.root)
    rmSync(join(lib.root, MANIFEST))
    // The next launch: files, and no manifest to tell Devot's from others.
    lib.host.setFolder(lib.root)
    lib.runner.reconcile()
    await until(() => lib.host.paused() === 'E_MIRROR_MANIFEST_MISSING')
    expect(walk(lib.root)).toEqual(files)
    writeFileSync(
      join(lib.root, MANIFEST),
      JSON.stringify({ version: 1, notes: {}, files: {}, books: {} }),
    )
    lib.host.setFolder(lib.root)
    lib.host.clear()
    lib.runner.reconcile()
    await lib.settled()
    expect(lib.host.paused()).toBe(null)
    expect(walk(lib.root)).toEqual(files)
    expect(lib.host.log).toEqual({ written: [], moved: [], removed: [], kept: [] })
    expect(Object.keys(lib.host.manifest().notes)).toHaveLength(3)
  })
})

describe('folders replaced by links', () => {
  it("a notebook's folder: its notes get a new folder, and nothing goes through the link", async () => {
    const lib = await sample()
    await mirrorOn(lib)
    lib.runner.stop()
    const elsewhere = join(tempDir('devot-mirror-elsewhere-'), 'Work')
    renameSync(join(lib.root, 'Work'), elsewhere)
    symlinkSync(elsewhere, join(lib.root, 'Work'))
    const outside = walk(elsewhere).map((path) => [path, readIn(elsewhere, path)])
    lib.runner.reconcile()
    await lib.settled()
    expect(walk(elsewhere).map((path) => [path, readIn(elsewhere, path)])).toEqual(outside)
    expect(read(lib, 'Work 2/Inbox.md')).toBe('# Inbox\n\nLoose thoughts.\n')
    expect(read(lib, 'Work 2/Plans/Launch.md')).toContain('](../../attachments/board.png#half)')
    expect(lib.host.manifest().books[lib.ids.work]).toBe('Work 2')
    expect(lib.errors).toEqual([])
  })
})

describe('a note whose place never settles', () => {
  it('is left as it is after a few tries, and never holds up the others', async () => {
    const lib = await sample()
    // Every name the Loose note could take holds something new each time.
    let seen = 0
    const check = lib.host.check.bind(lib.host)
    lib.host.check = async (generation, paths) => {
      const found = await check(generation, paths)
      for (const path of paths ?? []) {
        if (/^Loose( \d+)?\.md$/.test(path)) found[path] = sha256Hex(`theirs ${(seen += 1)}`)
      }
      return found
    }
    lib.runner.reconcile()
    await lib.runner.idle()
    expect(walk(lib.root)).toEqual([
      'Work/Inbox.md',
      'Work/Plans/Launch.md',
      'attachments/board.png',
    ])
    expect(lib.errors).toContain('E_MIRROR_UNSETTLED')
  })
})

describe('files edited outside Devot', () => {
  const edit = (lib: Library, path: string, text = 'edited outside\n') =>
    writeFileSync(join(lib.root, path), text)
  const kept = (lib: Library, path: string) => path.replace(/(\.\w+)$/, ' (edited outside Devot)$1')

  it('are kept under a new name when the note is edited, and never touched again', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    edit(lib, 'Work/Inbox.md')
    await lib.notes.setBody(lib.ids.inbox, '# Inbox\n\nDevot edit.\n')
    await lib.settled()
    expect(read(lib, kept(lib, 'Work/Inbox.md'))).toBe('edited outside\n')
    expect(read(lib, 'Work/Inbox.md')).toBe('# Inbox\n\nDevot edit.\n')
    expect(lib.host.log.kept).toEqual(['Work/Inbox (edited outside Devot).md'])
    const paths = Object.values(lib.host.manifest().notes).map((e) => e.path)
    expect(paths).not.toContain('Work/Inbox (edited outside Devot).md')
    // A second edit outside and in Devot: numbered, the first copy untouched.
    edit(lib, 'Work/Inbox.md', 'again\n')
    await lib.notes.setBody(lib.ids.inbox, '# Inbox\n\nDevot again.\n')
    await lib.settled()
    expect(read(lib, 'Work/Inbox (edited outside Devot).md')).toBe('edited outside\n')
    expect(read(lib, 'Work/Inbox (edited outside Devot) 2.md')).toBe('again\n')
  })

  it('are kept when the note is renamed, moved or trashed', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    edit(lib, 'Work/Inbox.md')
    edit(lib, 'Loose.md')
    edit(lib, 'Work/Plans/Launch.md')
    await lib.notes.setTitle(lib.ids.inbox, 'Renamed')
    await lib.notes.setBook(lib.ids.loose, lib.ids.work)
    await lib.notes.trash(lib.ids.plan)
    await lib.settled()
    expect(lib.host.log.kept.sort()).toEqual([
      'Loose (edited outside Devot).md',
      'Work/Inbox (edited outside Devot).md',
      'Work/Plans/Launch (edited outside Devot).md',
    ])
    for (const path of lib.host.log.kept) expect(read(lib, path)).toBe('edited outside\n')
    expect(walk(lib.root).filter((p) => !p.includes('edited outside'))).toEqual([
      'Work/Loose.md',
      'Work/Renamed.md',
    ])
  })

  it('are kept by a reconcile (launch), and an attachment by a purge or by turning copies off', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    lib.runner.stop()
    edit(lib, 'Loose.md')
    rmSync(join(lib.root, 'Work/Inbox.md'))
    lib.runner.reconcile()
    await lib.settled()
    expect(lib.host.log.kept).toEqual(['Loose (edited outside Devot).md'])
    expect(read(lib, 'Loose.md')).toBe('At the top.\n')
    expect(read(lib, 'Work/Inbox.md')).toBe('# Inbox\n\nLoose thoughts.\n')

    lib.host.clear()
    writeFileSync(join(lib.root, 'attachments/board.png'), 'edited image')
    await lib.notes.trash(lib.ids.plan)
    await lib.notes.purge(lib.ids.plan)
    await lib.settled()
    expect(lib.host.log.kept).toEqual(['attachments/board (edited outside Devot).png'])
    expect(read(lib, 'attachments/board (edited outside Devot).png')).toBe('edited image')
  })
})

describe('Include Attachments', () => {
  it('off writes no copies and removes the ones written; on again copies them back', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    const before = lib.host.size()
    lib.host.setIncludeAttachments(false)
    lib.runner.reconcile()
    await lib.settled()
    expect(walk(lib.root)).toEqual(['Loose.md', 'Work/Inbox.md', 'Work/Plans/Launch.md'])
    expect(lib.host.log.removed).toEqual(['attachments/board.png'])
    // Links still point at the attachments folder, as in an export.
    expect(read(lib, 'Work/Plans/Launch.md')).toContain('](../../attachments/board.png#half)')
    expect(lib.host.size()).toBe(before - PNG.length)
    const shot = await lib.image(lib.ids.loose, 'shot.jpg', JPEG)
    await lib.notes.setBody(lib.ids.loose, `![s](devot://file/${shot})\n`)
    await lib.settled()
    expect(walk(lib.root).some((p) => p.startsWith('attachments/'))).toBe(false)
    expect(read(lib, 'Loose.md')).toContain('](attachments/shot.jpg)')

    lib.host.clear()
    lib.host.setIncludeAttachments(true)
    lib.runner.reconcile()
    await lib.settled()
    expect(lib.host.log.written.sort()).toEqual(['attachments/board.png', 'attachments/shot.jpg'])
    expect(readFileSync(join(lib.root, 'attachments/shot.jpg'))).toEqual(Buffer.from(JPEG))
  })
})

describe('reconciling', () => {
  it('on launch: catches changes made while the app was closed, and writes nothing else', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    lib.runner.stop()
    // A note created by devot-mcp straight in the database (no pass runs).
    const mcp = await lib.notes.create('From MCP', lib.ids.work)
    await lib.notes.setBody(mcp, 'Made by an agent.\n')
    await lib.notes.release(mcp)
    const relaunched = createMirrorRunner({
      storage: lib.sqlite,
      host: lib.host,
      untitled: 'Untitled',
      delayMs: 5,
    })
    runners.push(relaunched)
    lib.host.clear()
    relaunched.reconcile()
    await relaunched.idle()
    expect(lib.host.log).toEqual({
      written: ['Work/From MCP.md'],
      moved: [],
      removed: [],
      kept: [],
    })
  })

  it('after a restore from backup: the folder matches the restored database', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    const backup = join(tempDir('devot-mirror-backup-'), 'backup.sqlite')
    await lib.sqlite.db.backup(backup)
    await lib.notes.setTitle(lib.ids.loose, 'Changed later')
    await lib.notes.trash(lib.ids.inbox)
    await lib.note('Added later', null, 'New.\n')
    await lib.settled()
    expect(walk(lib.root)).toEqual([
      'Added later.md',
      'Changed later.md',
      'Work/Plans/Launch.md',
      'attachments/board.png',
    ])
    lib.runner.stop()
    const restored = library({ root: lib.root, dbPath: backup })
    restored.runner.reconcile()
    await restored.settled()
    expect(walk(lib.root)).toEqual([
      'Loose.md',
      'Work/Inbox.md',
      'Work/Plans/Launch.md',
      'attachments/board.png',
    ])
    expect(restored.host.log.kept).toEqual([])
  })
})

describe('the folder going away', () => {
  it('pauses the mirror (no crash) and resumes with a reconcile once the folder is back', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    // Moved away (an unmounted drive), inside a folder the test removes.
    const away = join(tempDir('devot-mirror-away-'), 'mirror')
    renameSync(lib.root, away)
    await lib.notes.setBody(lib.ids.inbox, '# Inbox\n\nWhile away.\n')
    await lib.notes.flush()
    await until(() => lib.host.paused() === 'E_MIRROR_FOLDER_MISSING')
    expect(lib.errors).toContain('E_MIRROR_FOLDER_MISSING')
    // Devot never makes the folder itself, however often it checks.
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(lib.root)).toBe(false)
    renameSync(away, lib.root)
    // The next check (a timer here; window focus or the timer in the app) resumes with a reconcile.
    await until(
      () => lib.host.paused() === null && read(lib, 'Work/Inbox.md').includes('While away.'),
    )
  })

  it('pauses while the folder cannot be written, and resumes when it can', async (context) => {
    if (process.getuid?.() === 0) context.skip('root ignores permissions')
    const lib = await sample()
    await mirrorOn(lib)
    chmodSync(lib.root, 0o555)
    try {
      await lib.notes.setBody(lib.ids.loose, 'Read-only.\n')
      await lib.notes.flush()
      await until(() => lib.host.paused() === 'E_MIRROR_FOLDER_READ_ONLY')
    } finally {
      chmodSync(lib.root, 0o755)
    }
    lib.runner.wake()
    await until(() => lib.host.paused() === null && read(lib, 'Loose.md').includes('Read-only.'))
    expect(lib.errors).toContain('E_MIRROR_FOLDER_READ_ONLY')
  })

  it('a locked folder inside it holds back only its own files', async (context) => {
    if (process.getuid?.() === 0) context.skip('root ignores permissions')
    const lib = await sample()
    await mirrorOn(lib)
    chmodSync(join(lib.root, 'Work'), 0o555)
    try {
      await lib.notes.setBody(lib.ids.inbox, '# Inbox\n\nLocked.\n')
      await lib.notes.setBody(lib.ids.loose, 'Free.\n')
      await lib.settled()
    } finally {
      chmodSync(join(lib.root, 'Work'), 0o755)
    }
    expect(lib.host.paused()).toBe(null)
    expect(read(lib, 'Loose.md')).toBe('Free.\n')
    expect(lib.errors).toContain('E_MIRROR_WRITE_FAILED')
    lib.runner.touch()
    await lib.notes.setBody(lib.ids.inbox, '# Inbox\n\nUnlocked.\n')
    await lib.settled()
    expect(read(lib, 'Work/Inbox.md')).toContain('Unlocked.')
  })
})

describe('a move whose new text cannot be written', () => {
  it('leaves the file listed where it went, and the next pass writes it there', async (context) => {
    if (process.getuid?.() === 0) context.skip('root ignores permissions')
    const lib = await sample()
    await mirrorOn(lib)
    const work = join(lib.root, 'Work')
    lib.host.afterMove = () => chmodSync(work, 0o555)
    try {
      await lib.notes.setTitle(lib.ids.inbox, 'Inbox 2026')
      await lib.settled()
    } finally {
      chmodSync(work, 0o755)
    }
    expect(lib.errors).toContain('E_MIRROR_WRITE_FAILED')
    expect(lib.host.manifest().notes[lib.ids.inbox]?.path).toBe('Work/Inbox 2026.md')
    lib.runner.touch()
    await lib.settled()
    expect(walk(lib.root).filter((p) => p.startsWith('Work/Inbox'))).toEqual(['Work/Inbox 2026.md'])
    expect(read(lib, 'Work/Inbox 2026.md')).toContain("title: 'Inbox 2026'")
  })

  it('a move cut short before the manifest was saved is finished where the file went', async () => {
    const lib = await sample()
    await mirrorOn(lib)
    const manifest = readFileSync(join(lib.root, MANIFEST))
    const before = readFileSync(join(lib.root, 'Work/Inbox.md'))
    await lib.notes.setTitle(lib.ids.inbox, 'Inbox 2026')
    await lib.settled()
    lib.runner.stop()
    // The process ended after the move, before the rewrite and the manifest listing it.
    writeFileSync(join(lib.root, 'Work/Inbox 2026.md'), before)
    writeFileSync(join(lib.root, MANIFEST), manifest)
    lib.host.setFolder(lib.root)
    lib.runner.reconcile()
    await lib.settled()
    expect(lib.errors).toEqual([])
    expect(walk(lib.root).filter((p) => p.startsWith('Work/Inbox'))).toEqual(['Work/Inbox 2026.md'])
    expect(read(lib, 'Work/Inbox 2026.md')).toContain("title: 'Inbox 2026'")
    expect(lib.host.manifest().notes[lib.ids.inbox]?.path).toBe('Work/Inbox 2026.md')
  })
})

async function importFolder(lib: Library, root: string, name: string) {
  const files = walk(root).filter((p) => p.endsWith('.md'))
  const scan: ImportScan = {
    id: 1,
    name,
    kind: 'folder',
    files: files.map((path) => ({ path, bytes: 0 })),
    images: [],
    skipped: [],
  }
  const source: ImportSource = {
    read: async (path) => readFileSync(join(root, path), 'utf8'),
    async attach(path, file) {
      await lib.sqlite.putFile(
        { ...file, name: path.split('/').pop() ?? 'image' },
        readFileSync(join(root, path)),
      )
    },
  }
  const destination = await lib.books.create(name, null)
  return importMarkdown({
    notes: lib.notes,
    books: lib.books,
    tags: lib.tags,
    newId: lib.newId,
    scan,
    source,
    destination,
  })
}

async function snapshot(lib: Library) {
  const books = await lib.sqlite.listBooks()
  const tagNames = new Map((await lib.sqlite.listTags()).map((t) => [t.id, t.name]))
  const pathOf = (bookId: string | null): string => {
    const found = books.find((b) => b.id === bookId)
    if (!found) return ''
    const parent = pathOf(found.parentId)
    return parent ? `${parent}/${found.name}` : found.name
  }
  const bytes = (body: string) =>
    body.replace(/devot:\/\/file\/([0-9a-f-]{36})/g, (_, fileId: string) => {
      const row = lib.sqlite.db.prepare('SELECT data FROM files WHERE id = ?').get(fileId) as
        | { data: Buffer }
        | undefined
      return `file:${row ? Buffer.from(row.data).toString('hex') : 'missing'}`
    })
  const notes = await Promise.all(
    (await lib.sqlite.listNotes())
      .filter((n) => n.bookId !== TEMPLATES_BOOK_ID)
      .map(async (n) => ({
        book: pathOf(n.bookId),
        title: n.title,
        body: bytes((await lib.sqlite.getNote(n.id))!.bodyMd),
        tags: n.tagIds.map((t) => tagNames.get(t)).sort(),
        status: n.status,
      })),
  )
  const key = (n: (typeof notes)[number]) => `${n.book}/${n.title}/${n.body}`
  return notes.sort((a, b) => key(a).localeCompare(key(b)))
}

describe('the mirror as a source', () => {
  it('imports back as the same notes (title, body, tags, status, notebooks, images)', async () => {
    const lib = await sample()
    const { ids } = lib
    // Harder cases: clashing titles, untitled note, own front matter, `#` tag, slash in title, shared image.
    await lib.note('Launch', ids.plans, 'Another launch.\n', { status: 'on_hold' })
    await lib.note('', ids.work, 'No title.\n', { tags: ['#urgent'] })
    await lib.note('Own', null, '---\nauthor: me\ntags: [mine]\n---\n# Own\n', { tags: ['mine'] })
    await lib.note('a/b', ids.plans, '# a/b\n')
    await lib.note('Shows the board', null, `![again](devot://file/${ids.board})\n`)
    await mirrorOn(lib)

    const fresh = library()
    const report = await importFolder(fresh, lib.root, 'Mirror')
    expect(report.problems).toEqual([])
    // Everything comes back inside one notebook named after the folder; notes in no notebook directly in it.
    const expected = (await snapshot(lib)).map((n) => ({
      ...n,
      book: n.book ? `Mirror/${n.book}` : 'Mirror',
    }))
    expect(await snapshot(fresh)).toEqual(expected)
  })
})
