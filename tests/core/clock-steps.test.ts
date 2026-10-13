// Clock steps: the system clock ran fast for a while (a day or more), then
// was set right. Writes made after that must still win over the values
// written while it ran fast, because the core's clock takes in every stamp
// it reads before writing over it (see receiveStored in hlc.ts). Run on
// real SQLite and on the UI tests' memory storage, which must answer alike.
// And compaction, which ages history by the clock, must not thin a note's
// latest work while the clock runs fast (see revisionsToDrop).
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  KEEP_NEWEST,
  type StorageAdapter,
} from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { watchSweeps } from '../support/sweeps'
import { tempDir } from '../support/temp-dirs'

const MINUTE = 60_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 12, 12)
/** A system clock eight days ahead. */
const FAST = NOW + 8 * DAY

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

let memoryStorage: StorageAdapter
beforeAll(async () => {
  useMemoryLocalStorage()
  ;({ memoryStorage } = await import('../../src/renderer/src/storage/memory'))
})
afterAll(restoreLocalStorage)

/** Opens one database, again at every call: each app start opens it anew. */
type Database = () => StorageAdapter

/** A new SQLite database, opened anew at every call. */
const sqlite = (): Database => {
  const path = join(tempDir('devot-clock-'), 'devot.sqlite')
  return () => {
    const storage = openSqliteAdapter(path)
    open.push(storage)
    return storage
  }
}

const databases: [string, () => Database][] = [
  ['SQLite', sqlite],
  [
    'the UI tests’ memory storage',
    () => {
      useMemoryLocalStorage()
      return () => memoryStorage
    },
  ],
]

/**
 * One start of the app on `database`, its system clock reading `at`. Each
 * start gets a clock of its own, as the app's window does.
 */
function start(database: Database, at: number, node: string) {
  const storage = database()
  const now = () => at
  const clock = createClock(node, now)
  const newId = createIdGenerator()
  return {
    storage,
    notes: createNoteService({ storage, clock, newId, now, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId, now }),
    tags: createTagService({ storage, clock, newId, now }),
  }
}

describe.each(databases)('writes after the clock is set back, on %s', (_, fresh) => {
  it('restores a note moved to the Trash while the clock ran fast', async () => {
    const database = fresh()
    const fast = start(database, FAST, 'fast')
    const id = await fast.notes.create('Plan')
    await fast.notes.trash(id)

    const right = start(database, NOW, 'right')
    await right.notes.restore(id)
    expect((await right.notes.list()).map((n) => n.id)).toEqual([id])
    expect(await right.notes.listTrash()).toEqual([])
  })

  it('renames, files, marks and unpins a note changed while the clock ran fast', async () => {
    const database = fresh()
    const fast = start(database, FAST, 'fast')
    const shelf = await fast.books.create('Shelf', null)
    const id = await fast.notes.create('Draft', shelf)
    await fast.notes.setStatus(id, 'active')
    await fast.notes.setPinned(id, true)
    await fast.notes.flush()

    const right = start(database, NOW, 'right')
    await right.notes.setTitle(id, 'Final')
    await right.notes.flush()
    await right.notes.writeMeta(id, { bookId: null })
    await right.notes.writeMeta(id, { status: 'completed' })
    await right.notes.writeMeta(id, { pinned: false })
    expect(await right.storage.getNote(id)).toMatchObject({
      title: 'Final',
      bookId: null,
      status: 'completed',
      pinned: false,
    })
    // And it can go to the Trash and come back again.
    await right.notes.trash(id)
    await right.notes.restore(id)
    expect((await right.notes.list()).map((n) => n.id)).toEqual([id])
  })

  it('renames a note after taking in a rename another process made with a fast clock', async () => {
    const database = fresh()
    const right = start(database, NOW, 'right')
    const id = await right.notes.create('Draft')
    await right.notes.open(id)
    await right.notes.flush()

    const fast = start(database, FAST, 'fast')
    await fast.notes.setTitle(id, 'Elsewhere')
    await fast.notes.flush()

    expect(await right.notes.mergeStored()).toEqual([{ id, title: 'Elsewhere' }])
    await right.notes.setTitle(id, 'Final')
    await right.notes.flush()
    expect(await right.storage.getNote(id)).toMatchObject({ title: 'Final' })
  })

  it('renames, moves and opens to AI a notebook made while the clock ran fast', async () => {
    const database = fresh()
    const fast = start(database, FAST, 'fast')
    const inbox = await fast.books.create('Inbox', null)
    const work = await fast.books.create('Work', null)

    const right = start(database, NOW, 'right')
    await right.books.rename(inbox, 'Later')
    await right.books.move(inbox, work)
    await right.books.setAiAccess(inbox, true)
    expect((await right.books.list()).find((b) => b.id === inbox)).toMatchObject({
      name: 'Later',
      parentId: work,
      aiAccess: true,
    })
    // Back to the top level, after Work.
    await right.books.place(inbox, work, 'after')
    expect((await right.books.list()).find((b) => b.id === inbox)?.parentId).toBeNull()
  })

  it('renames, colours and deletes a tag made while the clock ran fast', async () => {
    const database = fresh()
    const fast = start(database, FAST, 'fast')
    const tag = await fast.tags.ensure('later')
    await fast.tags.setColor(tag, 'red')

    const right = start(database, NOW, 'right')
    await right.tags.rename(tag, 'soon')
    await right.tags.setColor(tag, 'blue')
    expect(await right.tags.list()).toMatchObject([{ id: tag, name: 'soon', color: 'blue' }])
    await right.tags.remove(tag)
    expect(await right.tags.list()).toEqual([])
  })

  it('takes off a tag put on a note while the clock ran fast, and puts it back', async () => {
    const database = fresh()
    const fast = start(database, FAST, 'fast')
    const id = await fast.notes.create('Note')
    const tag = await fast.tags.addToNote(id, 'urgent')

    const right = start(database, NOW, 'right')
    await right.tags.removeFromNote(id, tag)
    expect((await right.notes.list())[0]?.tagIds).toEqual([])
    expect(await right.storage.getNoteTag(id, tag)).toMatchObject({ present: false })
    await right.tags.putOnNote(id, tag)
    expect((await right.notes.list())[0]?.tagIds).toEqual([tag])
    expect(await right.storage.getNoteTag(id, 'none')).toBeNull()
  })
})

describe('compaction across clock steps, on SQLite', () => {
  it('keeps a note’s newest versions through a start eight days fast', async () => {
    const database = sqlite()
    // A day of writing, more versions than the newest kept, a version every
    // forty minutes, then a sweep, all on a right clock.
    const right = start(database, NOW, 'right')
    const written = await right.notes.create('Written')
    const ydoc = (await right.storage.getNote(written))!.ydoc
    const versions = Array.from({ length: KEEP_NEWEST + 10 }, (_, k) => ({
      id: `0192a6f0-0000-7000-8000-${String(k + 1).padStart(12, '0')}`,
      noteId: written,
      kind: 'body' as const,
      at: NOW - k * 40 * MINUTE,
      ydoc,
      length: 0,
      value: null,
    }))
    for (const version of versions) await right.storage.putRevision(version)
    await right.storage.compactRevisions([], NOW)

    // The next start's clock reads eight days ahead: that day looks a week
    // old. A save of another note sweeps, and that day's versions all stay:
    // their ages count from the note's newest one, not from a fast now.
    const fast = start(database, FAST, 'fast')
    const sweeps = watchSweeps(fast.storage)
    const edited = await fast.notes.create('Edited')
    await fast.notes.setBody(edited, 'typed while fast')
    await fast.notes.flush({ versions: true })
    await sweeps.until(1)
    const left = (await fast.storage.listRevisions(written)).map((r) => r.id)
    expect(left).toEqual(versions.map((v) => v.id))

    // Set right again, a day on: the last sweep looks to come from the
    // future, so the next one weighs every note again, and records now.
    const later = start(database, NOW + DAY, 'later')
    const laterSweeps = watchSweeps(later.storage)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const third = await later.notes.create('Later')
    await later.notes.setBody(third, 'set right')
    await later.notes.flush()
    await laterSweeps.until(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(await later.storage.lastCompaction()).toBe(NOW + DAY)
    expect((await later.storage.listRevisions(written)).map((r) => r.id)).toEqual(left)
    // The version taken while the clock ran fast is still the edited note's.
    expect(await later.storage.listRevisions(edited)).toHaveLength(1)
  })
})
