// Another process writing to the database while Devot runs (devot-mcp; any
// writer on another connection): the window hears of it (devot://db-changed)
// and the note service takes what storage holds into the notes it keeps in
// memory (mergeStored), so its next write keeps the other's changes. A write
// made before the window hears of it is refused by storage (its body version
// moved on) and made again after a merge, so it keeps them too.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  type NoteRecord,
  type NoteService,
  type SaveProblem,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

/** One process on the database at `path`: its note service and connection. */
function processOn(path: string, node: string) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock(node)
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  return { notes, storage, books: createBookService({ storage, clock, newId }) }
}

/** Two processes on one database file. */
function twoProcesses() {
  const path = join(tempDir('devot-outside-'), 'devot.sqlite')
  return { a: processOn(path, 'a1'), b: processOn(path, 'b1') }
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A note A made and saved with `body`, which B opens as A saved it. */
async function shared(a: NoteService, b: NoteService, body: string) {
  const id = await a.create('Plan')
  await a.setBody(id, body)
  await a.flush()
  await b.open(id)
  return id
}

/**
 * Another process writes to the stored note, as a writer that read it does:
 * its Yjs document takes `edit`, written over the body version it read.
 */
async function editStored(storage: SqliteAdapter, id: string, edit: (text: Y.Text) => void) {
  const stored = await storage.getNote(id, { trashed: true })
  if (!stored) throw new Error(`E_TEST_NO_NOTE ${id}`)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, stored.ydoc)
  edit(doc.getText(BODY))
  await storage.putNote({
    ...stored,
    bodyMd: doc.getText(BODY).toString(),
    ydoc: Y.encodeStateAsUpdate(doc),
    updatedAt: stored.updatedAt + 1,
  })
}

/** Appends `text` to the body of the stored note, as another process. */
const appendStored = (storage: SqliteAdapter, id: string, text: string) =>
  editStored(storage, id, (body) => body.insert(body.length, text))

/**
 * A process on the database at `path` whose storage runs what `afterNextRead`
 * was given once its next read of a note has landed, before the caller has
 * it: another process writing between that read and the write based on it.
 */
function processReadingOn(path: string, node: string) {
  const sqlite = openSqliteAdapter(path)
  open.push(sqlite)
  let between: (() => Promise<void>) | undefined
  const storage = Object.assign(Object.create(sqlite) as SqliteAdapter, {
    async getNote(id: string, options?: { trashed?: boolean }) {
      const record = await sqlite.getNote(id, options)
      const run = between
      between = undefined
      if (run) await run()
      return record
    },
  })
  const notes = createNoteService({
    storage,
    clock: createClock(node),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  const afterNextRead = (run: () => Promise<void>) => {
    between = run
  }
  return { notes, storage: sqlite, afterNextRead }
}

describe('writes from another process', () => {
  it('a pin in one process keeps the text another saved meanwhile', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'First draft')
    await b.notes.setBody(id, 'First draft, edited in B')
    await b.notes.flush()

    // A hears that the database changed, then pins the note.
    await a.notes.mergeStored()
    await a.notes.writeMeta(id, { pinned: true })
    const stored = await a.storage.getNote(id)
    expect(stored?.bodyMd).toBe('First draft, edited in B')
    expect(stored?.pinned).toBe(true)
  })

  it('typing in both keeps both, whichever saves last', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'middle')
    // A types and has not saved yet; B types and saves.
    await a.notes.setBody(id, 'start middle')
    await b.notes.setBody(id, 'middle end')
    await b.notes.flush()

    await a.notes.mergeStored()
    await a.notes.flush()
    expect((await a.storage.getNote(id))?.bodyMd).toBe('start middle end')
    // What A shows (and its editor takes in, see the window) has both too.
    expect(textOf((await a.notes.open(id)).state)).toBe('start middle end')
  })

  it('writes the note again when the other wrote over edits it had saved', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'one')
    // A saves an edit; B writes a copy of its own over it, one that lacks
    // A's edit (over the body version stored, so storage takes it: a writer
    // that put back an old copy, say).
    await a.notes.setBody(id, 'one two')
    await a.notes.flush()
    const copy = new Y.Doc()
    Y.applyUpdate(copy, (await b.notes.open(id)).state)
    copy.getText(BODY).insert(0, 'zero ')
    const stored = (await b.storage.getNote(id))!
    await b.storage.putNote({
      ...stored,
      bodyMd: copy.getText(BODY).toString(),
      ydoc: Y.encodeStateAsUpdate(copy),
    })
    expect((await a.storage.getNote(id))?.bodyMd).toBe('zero one')

    await a.notes.mergeStored()
    await sleep(30)
    await a.notes.flush()
    expect((await a.storage.getNote(id))?.bodyMd).toBe('zero one two')
  })

  it('takes the newer change of each metadata field', async () => {
    const { a, b } = twoProcesses()
    const inbox = await b.books.create('Inbox', null)
    const id = await shared(a.notes, b.notes, 'text')
    // A pins, not saved yet; B then renames and files the note, and saves.
    await a.notes.setPinned(id, true)
    await b.notes.setTitle(id, 'Renamed in B')
    await b.notes.setBook(id, inbox)
    await b.notes.flush()

    const retitled = await a.notes.mergeStored()
    expect(retitled).toEqual([{ id, title: 'Renamed in B' }])
    await a.notes.flush()
    const stored = await a.storage.getNote(id)
    expect(stored).toMatchObject({ title: 'Renamed in B', bookId: inbox, pinned: true })
    // A later change in A wins over B's.
    await a.notes.setTitle(id, 'Renamed in A')
    await a.notes.flush()
    expect((await a.storage.getNote(id))?.title).toBe('Renamed in A')
  })

  it('reports no title for a note whose title only this process changed', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'text')
    await a.notes.setTitle(id, 'Typed in A')
    await b.notes.setBody(id, 'text from B')
    await b.notes.flush()
    expect(await a.notes.mergeStored()).toEqual([])
  })

  it("takes the other's changes into every note in memory, open or not", async () => {
    const { a, b } = twoProcesses()
    /** A note B made and saved, which A opens. */
    const fromB = async (body: string) => {
      const id = await b.notes.create('From B')
      await b.notes.setBody(id, body)
      await b.notes.flush()
      await a.notes.open(id)
      return id
    }
    const shown = await fromB('shown')
    const closed = await fromB('closed')
    const typing = await fromB('typing')
    await a.notes.setBody(typing, 'typing, not saved')
    for (const id of [shown, closed, typing]) {
      const text = textOf((await b.notes.open(id)).state)
      await b.notes.setBody(id, `(B) ${text}`)
    }
    await b.notes.flush()

    await a.notes.mergeStored()
    expect(textOf((await a.notes.open(shown)).state)).toBe('(B) shown')
    expect(textOf((await a.notes.open(closed)).state)).toBe('(B) closed')
    expect(textOf((await a.notes.open(typing)).state)).toBe('(B) typing, not saved')
  })

  it('never loses an edit that loaded the note while the merge read it back', async () => {
    const path = join(tempDir('devot-outside-'), 'devot.sqlite')
    const sqlite = openSqliteAdapter(path)
    open.push(sqlite)
    // The next read of a note waits until the test lets it land.
    let land: ((record: NoteRecord | null) => void) | undefined
    let holdNextRead = false
    const storage = Object.assign(Object.create(sqlite) as SqliteAdapter, {
      getNote(id: string, options?: { trashed?: boolean }) {
        if (!holdNextRead) return sqlite.getNote(id, options)
        holdNextRead = false
        return new Promise<NoteRecord | null>((resolve) => (land = resolve))
      },
    })
    const notes = createNoteService({
      storage,
      clock: createClock('a1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const id = await notes.create('Plan')
    await notes.flush()

    holdNextRead = true
    const merging = notes.mergeStored()
    await sleep(0)
    const stored = await sqlite.getNote(id, { trashed: true })
    // The read lands just as a pin (a batch change, say) loads the note.
    land?.(stored)
    const pinning = notes.writeMeta(id, { pinned: true })
    await Promise.all([merging, pinning])
    await notes.flush()
    expect((await sqlite.getNote(id))?.pinned).toBe(true)
  })

  it('lets go of a note the other process deleted for good', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'doomed')
    await a.notes.setTitle(id, 'Edited in A')
    await b.notes.trash(id)
    await b.notes.purge(id)

    expect(await a.notes.mergeStored()).toEqual([])
    await a.notes.flush()
    await expect(a.notes.open(id)).rejects.toThrow('E_NOTE_NOT_FOUND')
    expect(await a.storage.getNote(id, { trashed: true })).toBeNull()
  })

  it('keeps a note trashed by the other process in the trash', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'text')
    await b.notes.trash(id)

    await a.notes.mergeStored()
    await a.notes.setBody(id, 'text, typed in A after')
    await a.notes.flush()
    const stored = await a.storage.getNote(id, { trashed: true })
    expect(stored?.deletedAt).not.toBeNull()
    expect(stored?.bodyMd).toBe('text, typed in A after')
  })
})

describe('a write made before the window hears of an outside write', () => {
  it('keeps both when typing is saved before the window hears', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'middle')
    // B types and saves; A types and saves before it hears of B's write.
    await b.notes.setBody(id, 'middle end')
    await b.notes.flush()
    await a.notes.setBody(id, 'start middle')
    await a.notes.flush()

    expect((await a.storage.getNote(id))?.bodyMd).toBe('start middle end')
    expect(textOf((await a.notes.open(id)).state)).toBe('start middle end')
    // Hearing of it afterwards changes nothing; B takes in A's part.
    await a.notes.mergeStored()
    await a.notes.flush()
    expect((await a.storage.getNote(id))?.bodyMd).toBe('start middle end')
    await b.notes.mergeStored()
    expect(textOf((await b.notes.open(id)).state)).toBe('start middle end')
  })

  it('keeps the text another process saved when a pin is saved before the window hears', async () => {
    const { a, b } = twoProcesses()
    const id = await shared(a.notes, b.notes, 'First draft')
    await b.notes.setBody(id, 'First draft, edited in B')
    await b.notes.flush()

    await a.notes.writeMeta(id, { pinned: true })
    const stored = await a.storage.getNote(id)
    expect(stored?.bodyMd).toBe('First draft, edited in B')
    expect(stored?.pinned).toBe(true)
  })

  it('keeps a body written between the read and the write of a change to a note not in memory', async () => {
    const path = join(tempDir('devot-outside-'), 'devot.sqlite')
    const b = processOn(path, 'b1')
    const a = processReadingOn(path, 'a1')
    const id = await b.notes.create('Plan')
    await b.notes.setBody(id, 'one')
    await b.notes.flush()

    // A pins the note without loading it; B writes between A's read and A's write.
    a.afterNextRead(() => appendStored(b.storage, id, ' two'))
    await a.notes.writeMeta(id, { pinned: true })
    const stored = await a.storage.getNote(id)
    expect(stored?.bodyMd).toBe('one two')
    expect(stored?.pinned).toBe(true)
  })

  it('keeps a body written between the read and the write of a restore from the Trash', async () => {
    const path = join(tempDir('devot-outside-'), 'devot.sqlite')
    const b = processOn(path, 'b1')
    const a = processReadingOn(path, 'a1')
    const id = await b.notes.create('Plan')
    await b.notes.setBody(id, 'one')
    await b.notes.flush()
    await b.notes.trash(id)

    a.afterNextRead(() => appendStored(b.storage, id, ' two'))
    await a.notes.restore(id)
    expect((await a.storage.getNote(id))?.bodyMd).toBe('one two')
  })

  it('keeps what another process wrote to a note it trashes, heard of or not', async () => {
    for (const heard of [true, false]) {
      const { a, b } = twoProcesses()
      const id = await shared(a.notes, b.notes, 'First draft')
      await b.notes.setBody(id, 'First draft, edited in B')
      await b.notes.flush()
      // Heard of: A takes the text in and has nothing of its own to save.
      if (heard) await a.notes.mergeStored()

      await a.notes.trash(id)
      const stored = await a.storage.getNote(id, { trashed: true })
      expect(stored?.deletedAt).not.toBeNull()
      expect(stored?.bodyMd).toBe('First draft, edited in B')
    }
  })

  it('keeps a save pending while another process writes before each try, and saves it once that stops', async () => {
    const path = join(tempDir('devot-outside-'), 'devot.sqlite')
    const other = openSqliteAdapter(path)
    open.push(other)
    const sqlite = openSqliteAdapter(path)
    open.push(sqlite)
    // While `ahead`, the other process writes to the note just before each write of this one.
    let ahead = false
    let theirs = 0
    const storage = Object.assign(Object.create(sqlite) as SqliteAdapter, {
      async putNote(record: NoteRecord) {
        if (ahead) await appendStored(other, record.id, ` ${(theirs += 1)}`)
        await sqlite.putNote(record)
      },
    })
    const problems: SaveProblem[][] = []
    const notes = createNoteService({
      storage,
      clock: createClock('a1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
      retryDelayMs: 60_000,
      onSaveProblems: (list) => problems.push(list),
    })
    const id = await notes.create('Plan')
    await notes.setBody(id, 'middle')
    await notes.flush()

    ahead = true
    await notes.setBody(id, 'start middle')
    await expect(notes.flush()).rejects.toThrow('E_NOTE_SAVE_FAILED')
    expect(problems.at(-1)).toEqual([{ id, code: 'E_NOTE_BODY_STALE' }])
    expect(theirs).toBeGreaterThan(1)

    ahead = false
    await notes.flush()
    const numbers = Array.from({ length: theirs }, (_, i) => ` ${i + 1}`).join('')
    expect((await sqlite.getNote(id))?.bodyMd).toBe(`start middle${numbers}`)
    expect(problems.at(-1)).toEqual([])
  })
})
