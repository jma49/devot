import { cpSync, readFileSync, utimesSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createMirrorRunner,
  createNoteService,
  createTagService,
  observeWrites,
  type MirrorHost,
  type MirrorOp,
  type MirrorRunner,
} from '../../src/core'
import { filesUnder } from '../support/files-under'
import { folderHost, MANIFEST, type FolderHost } from '../support/mirror-host'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// How much one pass of the mirror does: an edit plans only what changed and hashes the note once,
// and leaves the folder exactly as a plan of every note would.

const hashedInWorker = vi.hoisted(() => [] as string[])
vi.mock('../../src/core/sha256', async (original) => {
  const actual = await original<typeof import('../../src/core/sha256')>()
  return {
    ...actual,
    sha256Hex: (text: string) => {
      hashedInWorker.push(text)
      return actual.sha256Hex(text)
    },
  }
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])

const open: SqliteAdapter[] = []
const runners: MirrorRunner[] = []
afterEach(() => {
  runners.splice(0).forEach((r) => r.stop())
  open.splice(0).forEach((a) => a.close())
})

interface Calls {
  bodies: string[]
  files: string[]
  checks: (readonly string[] | null)[]
  batches: MirrorOp[][]
}

function counted(host: FolderHost): { host: MirrorHost; calls: Calls } {
  const calls: Calls = { bodies: [], files: [], checks: [], batches: [] }
  return {
    calls,
    host: {
      open: (known) => host.open(known),
      bodies(ids) {
        calls.bodies.push(...ids)
        return host.bodies(ids)
      },
      files(ids) {
        calls.files.push(...ids)
        return host.files(ids)
      },
      hashes: (ids) => host.hashes(ids),
      check(generation, paths) {
        calls.checks.push(paths)
        return host.check(generation, paths)
      },
      apply(generation, ops) {
        calls.batches.push([...ops])
        return host.apply(generation, ops)
      },
    },
  }
}

/**
 * One library mirrored to two folders: `mirror` as the main window runs it (each write names its
 * notes), `reference` told of every write without its notes, so each of its passes plans every note.
 */
function twins() {
  const sqlite = openSqliteAdapter(join(tempDir('devot-mirror-pass-db-'), 'db.sqlite'))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const made: MirrorRunner[] = []
  const storage = observeWrites(sqlite, (ids) => {
    made[0]?.touch(ids)
    made[1]?.touch()
  })
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const errors: string[] = []
  const side = (root: string) => {
    const folder = folderHost(sqlite, root)
    const { host, calls } = counted(folder)
    const runner = createMirrorRunner({
      storage,
      host,
      untitled: 'Untitled',
      delayMs: 5,
      maxWaitMs: 50,
      retryMs: 20,
      onError: (code) => errors.push(code),
    })
    runners.push(runner)
    made.push(runner)
    return { root, folder, calls, runner }
  }
  const mirror = side(tempDir('devot-mirror-pass-a-'))
  const reference = side(tempDir('devot-mirror-pass-b-'))
  return {
    sqlite,
    newId,
    notes,
    books,
    tags,
    errors,
    mirror,
    reference,
    async settled() {
      await notes.flush()
      await mirror.runner.idle()
      await reference.runner.idle()
    },
    async note(title: string, bookId: string | null, body: string) {
      const id = await notes.create(title, bookId)
      await notes.setBody(id, body)
      await notes.release(id)
      return id
    },
    /** Both folders, every file with its bytes, the manifest included. */
    folders() {
      const contents = (root: string) =>
        Object.fromEntries(
          filesUnder(root).map((path) => [path, readFileSync(join(root, path)).toString('base64')]),
        )
      return {
        mirror: contents(mirror.root),
        reference: contents(reference.root),
      }
    },
  }
}

type Twins = ReturnType<typeof twins>

async function populated(count: number) {
  const lib = twins()
  const work = await lib.books.create('Work', null)
  const plans = await lib.books.create('Plans', work)
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const book = i % 3 === 0 ? null : i % 3 === 1 ? work : plans
    ids.push(await lib.note(`Note ${i % 40}`, book, `Body of note ${i}.\n`))
  }
  // Notes that show an image: a plan of every note asks for each image's name.
  const pictured = ids.filter((_, i) => i % 10 === 0)
  for (const id of pictured) {
    const fileId = lib.newId()
    await lib.sqlite.putFile({ id: fileId, noteId: id, name: 'board.png' }, PNG)
    await lib.notes.setBody(id, `With an image.\n\n![Board](devot://file/${fileId})\n`)
    await lib.notes.release(id)
  }
  lib.mirror.runner.reconcile()
  lib.reference.runner.reconcile()
  await lib.settled()
  return { ...lib, work, plans, ids, pictured }
}

const clear = (lib: Twins) => {
  for (const side of [lib.mirror, lib.reference]) {
    side.calls.bodies.length = 0
    side.calls.files.length = 0
    side.calls.checks.length = 0
    side.calls.batches.length = 0
    side.folder.clear()
  }
  hashedInWorker.length = 0
}

describe('a pass after an edit', () => {
  it('plans only the notes written since, hashes each once outside the worker, and writes the manifest once', async () => {
    const lib = await populated(120)
    const plain = lib.ids.filter((id) => !lib.pictured.includes(id))
    for (const [n, id] of plain.slice(0, 10).entries()) {
      clear(lib)
      await lib.notes.setBody(id, `Edited ${n} times.\n`)
      await lib.notes.release(id)
      await lib.settled()
      const path = lib.mirror.folder.manifest().notes[id]!.path
      const { calls, folder } = lib.mirror
      expect(calls.bodies).toEqual([id])
      expect(calls.files).toEqual([])
      expect(calls.checks).toEqual([])
      expect(calls.batches).toHaveLength(1)
      const [op] = calls.batches[0]!
      expect(calls.batches[0]).toHaveLength(1)
      expect(op).toMatchObject({ kind: 'note', id, path, from: path })
      expect(op && 'sha256' in op).toBe(false)
      const text = readFileSync(join(lib.mirror.root, path), 'utf8')
      expect(op?.kind === 'note' && op.text).toBe(text)
      expect(hashedInWorker).not.toContain(text)
      expect(folder.counts).toEqual({ hashed: 1, saved: 1 })
      // Every pass of the reference plans every note: it asks for every image's name.
      expect(lib.reference.calls.files).toHaveLength(lib.pictured.length)
    }
    expect(lib.folders().mirror).toEqual(lib.folders().reference)
    expect(lib.errors).toEqual([])
  })
})

describe('the folder a pass leaves', () => {
  it('is byte for byte the one a plan of every note leaves, through renames, moves, deletes, conflicts and outside edits', async () => {
    const lib = await populated(30)
    const [a, b, c, d, e] = lib.ids
    const same = async (change: () => Promise<unknown>) => {
      await change()
      await lib.settled()
      const { mirror, reference } = lib.folders()
      expect(mirror).toEqual(reference)
    }
    const both = (path: string, text: string) => {
      for (const root of [lib.mirror.root, lib.reference.root])
        writeFileSync(join(root, path), text)
    }
    const pathOf = (id: string) => lib.mirror.folder.manifest().notes[id]!.path

    await same(() => lib.notes.setBody(a!, 'A new body.\n'))
    await same(() => lib.notes.setTitle(b!, 'Renamed'))
    await same(() => lib.notes.setTitle(c!, 'Note 1'))
    await same(() => lib.notes.setBook(d!, lib.plans))
    await same(() => lib.tags.addToNote(a!, 'q4'))
    await same(() => lib.notes.setStatus(a!, 'active'))
    await same(() => lib.notes.trash(e!))
    await same(() => lib.notes.restore(e!))
    // Edited outside Devot, then in Devot: the outside text is kept aside in both.
    both(pathOf(a!), 'Their edit.\n')
    await same(() => lib.notes.setBody(a!, 'Devot again.\n'))
    expect(lib.mirror.folder.log.kept).toHaveLength(1)
    // A file of someone else's where a renamed note would go.
    both('Taken.md', 'Theirs.\n')
    await same(() => lib.notes.setTitle(b!, 'Taken'))
    expect(readFileSync(join(lib.mirror.root, 'Taken.md'), 'utf8')).toBe('Theirs.\n')
    // Changed outside Devot to the very text Devot writes next: taken as Devot's.
    await lib.notes.setBody(c!, 'Settled.\n')
    await lib.settled()
    const next = readFileSync(join(lib.reference.root, pathOf(c!)), 'utf8')
    await lib.notes.setBody(c!, 'Unsettled.\n')
    await lib.settled()
    both(pathOf(c!), next)
    await same(() => lib.notes.setBody(c!, 'Settled.\n'))
    await same(() => lib.books.rename(lib.work, 'Job'))
    await same(async () => {
      await lib.notes.trash(d!)
      await lib.notes.purge(d!)
    })
    await same(() => lib.books.remove(lib.plans))
    expect(lib.errors).toEqual([])
  })

  it('catches an outside edit that keeps the size and the modification time', async () => {
    const lib = await populated(6)
    const a = lib.ids[1]
    const path = lib.mirror.folder.manifest().notes[a!]!.path
    const file = join(lib.mirror.root, path)
    const before = readFileSync(file, 'utf8')
    const { mtime, atime } = statSync(file)
    writeFileSync(file, before.replace('Body', 'Bxdy'))
    utimesSync(file, atime, mtime)
    await lib.notes.setBody(a!, 'From Devot.\n')
    await lib.settled()
    expect(lib.mirror.folder.log.kept).toEqual([path.replace('.md', ' (edited outside Devot).md')])
    expect(readFileSync(join(lib.mirror.root, lib.mirror.folder.log.kept[0]!), 'utf8')).toBe(
      before.replace('Body', 'Bxdy'),
    )
  })
})

describe('a restart in the middle of a pass', () => {
  it('a stop during a batch: the next launch ends with the folder a plan of every note leaves', async () => {
    const lib = await populated(30)
    const apply = lib.mirror.folder.apply.bind(lib.mirror.folder)
    let stopped: Promise<void> | undefined
    lib.mirror.folder.apply = async (generation, ops) => {
      const results = await apply(generation, ops.slice(0, 1))
      stopped ??= lib.mirror.runner.stop()
      return results
    }
    for (const id of lib.ids.slice(0, 5)) await lib.notes.setBody(id, `After ${id}.\n`)
    await lib.settled()
    await stopped
    // A new launch: what Rust held is gone, the manifest is read from the folder.
    const relaunched = folderHost(lib.sqlite, lib.mirror.root)
    const runner = createMirrorRunner({
      storage: lib.sqlite,
      host: relaunched,
      untitled: 'Untitled',
      delayMs: 5,
    })
    runners.push(runner)
    runner.reconcile()
    await runner.idle()
    expect(relaunched.log.kept).toEqual([])
    const { mirror, reference } = lib.folders()
    expect(mirror).toEqual(reference)
  })

  it('a batch whose manifest never reached the disk: its files are taken back, nothing is kept aside', async () => {
    const lib = await populated(30)
    const saved = join(tempDir('devot-mirror-pass-saved-'), MANIFEST)
    cpSync(join(lib.mirror.root, MANIFEST), saved)
    for (const id of lib.ids.slice(0, 5)) await lib.notes.setBody(id, `After ${id}.\n`)
    await lib.notes.setTitle(lib.ids[5]!, 'Moved on')
    await lib.settled()
    await lib.mirror.runner.stop()
    cpSync(saved, join(lib.mirror.root, MANIFEST))
    const relaunched = folderHost(lib.sqlite, lib.mirror.root)
    const runner = createMirrorRunner({
      storage: lib.sqlite,
      host: relaunched,
      untitled: 'Untitled',
      delayMs: 5,
    })
    runners.push(runner)
    runner.reconcile()
    await runner.idle()
    expect(relaunched.log).toEqual({
      written: [],
      moved: [],
      removed: [],
      kept: [],
    })
    const { mirror, reference } = lib.folders()
    expect(mirror).toEqual(reference)
  })
})
