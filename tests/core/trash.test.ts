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
  type NoteRecord,
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
    /** The note with `change`, written over the body as stored now. */
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
