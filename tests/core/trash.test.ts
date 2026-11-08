import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  newWriter,
  type NoteRecord,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-trash-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
  }
}

/** Storage that holds the write moving a note to the Trash until `release` is called. */
function heldTrash() {
  const sqlite = openSqliteAdapter(join(tempDir('devot-trash-'), 'devot.sqlite'))
  open.push(sqlite)
  let reach = () => {}
  let release = () => {}
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const held = new Promise<void>((resolve) => (release = resolve))
  const storage: StorageAdapter = Object.assign(Object.create(sqlite) as SqliteAdapter, {
    async putNote(record: Parameters<StorageAdapter['putNote']>[0]) {
      if (record.deletedAt !== null) {
        reach()
        await held
      }
      return sqlite.putNote(record)
    },
  })
  return { sqlite, storage, reached, release: () => release() }
}

async function write(notes: ReturnType<typeof setup>['notes'], id: string, text: string) {
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  const before = Y.encodeStateVector(doc)
  doc.getText(BODY).insert(0, text)
  await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
  await notes.flush()
}

describe('trash on SQLite', () => {
  it('moves a note to the trash: gone from the list and from opening', async () => {
    const { notes } = setup()
    const id = await notes.create('Doomed')
    await notes.create('Kept')
    await notes.trash(id)
    expect((await notes.list()).map((n) => n.title)).toEqual(['Kept'])
    expect((await notes.listTrash()).map((n) => n.title)).toEqual(['Doomed'])
    await expect(notes.open(id)).rejects.toThrow('E_NOTE_NOT_FOUND')
  })

  it('shows a trashed note read-only with its body', async () => {
    const { notes } = setup()
    const id = await notes.create('Doomed')
    await write(notes, id, '# Last words')
    await notes.trash(id)
    expect(await notes.peekTrashed(id)).toEqual({
      id,
      title: 'Doomed',
      bodyMd: '# Last words',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    })
  })

  it('restores a note with its body and metadata intact', async () => {
    const { notes, books, tags } = setup()
    const work = await books.create('Work', null)
    const id = await notes.create('Back', work)
    await write(notes, id, 'body text')
    await notes.setStatus(id, 'active')
    await notes.setPinned(id, true)
    await notes.flush()
    const tag = await tags.addToNote(id, 'keep')
    await notes.trash(id)
    await notes.restore(id)
    const [back] = await notes.list()
    expect(back).toMatchObject({
      id,
      title: 'Back',
      bookId: work,
      status: 'active',
      pinned: true,
      tagIds: [tag],
    })
    expect((await notes.open(id)).title).toBe('Back')
    expect(await notes.listTrash()).toEqual([])
  })

  it('restores a note whose stored title storage would refuse now', async () => {
    const { notes, storage } = setup()
    // Stored by an older build: a carriage return, and past the limit.
    for (const title of ['two\rlines', 'x'.repeat(1500)]) {
      const id = await notes.create('Old', null)
      await notes.release(id)
      await notes.trash(id)
      storage.db.prepare('UPDATE notes SET title = ? WHERE id = ?').run(title, id)
      await notes.restore(id)
      expect((await notes.list()).map((n) => n.id)).toContain(id)
      // The stored title stays until a rename, as for a note opened.
      expect((await storage.getNote(id))?.title).toBe(title)
    }
    expect(await notes.listTrash()).toEqual([])
  })

  it('empties the trash permanently, wiping content but keeping the tombstone', async () => {
    const { storage, notes } = setup()
    const a = await notes.create('Secret A')
    await write(notes, a, 'private')
    const b = await notes.create('Secret B')
    const kept = await notes.create('Kept')
    await notes.trash(a)
    await notes.trash(b)
    expect(await notes.emptyTrash()).toBe(2)
    expect(await notes.listTrash()).toEqual([])
    expect((await notes.list()).map((n) => n.id)).toEqual([kept])
    const row = storage.db
      .prepare('SELECT title, body_md, length(ydoc) AS size, purged_at FROM notes WHERE id = ?')
      .get(a) as { title: string; body_md: string; size: number; purged_at: number | null }
    expect(row).toMatchObject({ title: '', body_md: '', size: 0 })
    expect(row.purged_at).not.toBeNull()
  })

  it('deletes one trashed note permanently', async () => {
    const { notes } = setup()
    const a = await notes.create('A')
    const b = await notes.create('B')
    await notes.trash(a)
    await notes.trash(b)
    await notes.purge(a)
    expect((await notes.listTrash()).map((n) => n.id)).toEqual([b])
  })

  it('never purges a note that is not in the trash', async () => {
    const { notes } = setup()
    const id = await notes.create('Live')
    await expect(notes.purge(id)).rejects.toThrow('E_NOTE_NOT_IN_TRASH')
  })

  it('a purge is final: a later write of an old copy cannot bring the note back', async () => {
    const { storage, notes } = setup()
    const id = await notes.create('Gone')
    const stale = (await storage.getNote(id))!
    await notes.trash(id)
    await notes.purge(id)
    await storage.putNote({ ...stale, title: 'Revived', titleHlc: '9999999999999999-0000-zz' })
    expect(await storage.getNote(id, { trashed: true })).toBeNull()
    expect(await notes.list()).toEqual([])
  })

  it('a newer restore wins over an older trash, and a newer trash over an older restore', async () => {
    const { storage, notes } = setup()
    const id = await notes.create('Flip')
    const live = (await storage.getNote(id))!
    const put = async (change: Pick<NoteRecord, 'deletedAt' | 'deletedHlc'>) => {
      const { bodyVersion } = (await storage.getNote(id, { trashed: true }))!
      await storage.putNote({ ...live, ...change, bodyVersion })
    }
    await put({ deletedAt: 5, deletedHlc: '0000000000000005-0000-a' })
    await put({ deletedAt: null, deletedHlc: '0000000000000009-0000-b' })
    expect((await notes.list()).map((n) => n.id)).toEqual([id])
    await put({ deletedAt: 3, deletedHlc: '0000000000000004-0000-c' })
    expect((await notes.list()).map((n) => n.id)).toEqual([id])
  })
})

describe('discarding an empty note on SQLite', () => {
  it('deletes a live note with no title and no body for good, without the Trash', async () => {
    const { storage, notes } = setup()
    const id = await notes.create('', null)
    await notes.open(id)
    await notes.discardEmpty(id)
    expect(await notes.list()).toEqual([])
    expect(await notes.listTrash()).toEqual([])
    expect(await storage.getNote(id, { trashed: true })).toBeNull()
  })

  it('refuses a note with a title, and keeps it', async () => {
    const { notes } = setup()
    const id = await notes.create('Plans', null)
    await expect(notes.discardEmpty(id)).rejects.toThrow('E_NOTE_NOT_TRASHED')
    expect((await notes.list()).map((n) => n.id)).toEqual([id])
  })

  it('refuses a note whose body was typed but not saved yet, and keeps the text', async () => {
    const { notes } = setup()
    const id = await notes.create('', null)
    const opened = await notes.open(id)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, opened.state)
    const before = Y.encodeStateVector(doc)
    doc.getText(BODY).insert(0, 'a')
    await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
    await expect(notes.discardEmpty(id)).rejects.toThrow('E_NOTE_NOT_TRASHED')
    expect((await notes.read(id)).bodyMd).toBe('a')
  })

  it('leaves a note in the Trash to Empty Trash', async () => {
    const { notes } = setup()
    const id = await notes.create('', null)
    await notes.trash(id)
    await expect(notes.discardEmpty(id)).rejects.toThrow('E_NOTE_NOT_FOUND')
    expect((await notes.listTrash()).map((n) => n.id)).toEqual([id])
  })
})

describe('a note on its way to the Trash', () => {
  it('refuses an agent edit and a status change, and restores without them', async () => {
    const { storage, reached, release } = heldTrash()
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const id = await notes.create('Doomed')
    await write(notes, id, 'Kept text.')
    const trashing = notes.trash(id)
    await reached
    const agent = notes.agentWrite(id, {
      writer: newWriter('mcp', 'Agent', 'mcp00aa11bb22cc'),
      markdown: 'Lost text.\n',
    })
    const status = notes.setStatusUndoable(id, 'active')
    const outcomes = Promise.allSettled([agent, status])
    release()
    await trashing
    const [agentOutcome, statusOutcome] = await outcomes
    expect(agentOutcome).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'E_NOTE_TRASHED' }),
    })
    expect(statusOutcome).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'E_NOTE_TRASHED' }),
    })
    await notes.flush()
    await notes.restore(id)
    const back = await notes.read(id)
    expect(back.bodyMd).toBe('Kept text.')
    expect((await storage.getNote(id))?.status).toBe('none')
  })
})

describe('another note while one is on its way to the Trash', () => {
  it('saves all and purges as if the moving note were not there', async () => {
    const { sqlite, storage, reached, release } = heldTrash()
    let problems: unknown[] = []
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
      onSaveProblems: (now) => (problems = now),
    })
    const other = await notes.create('Already trashed')
    await notes.flush()
    const stored = await sqlite.getNote(other)
    await sqlite.putNote({ ...stored!, deletedAt: 1, deletedHlc: 'z' })
    await notes.release(other)
    const id = await notes.create('Doomed')
    await write(notes, id, 'Kept text.')
    const trashing = notes.trash(id)
    await reached
    await expect(notes.setStatus(id, 'active')).rejects.toThrow('E_NOTE_TRASHED')
    const during = Promise.allSettled([notes.flush(), notes.purge(other), notes.release(id)])
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await trashing
    expect((await during).map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
    expect(problems).toEqual([])
  })
})
