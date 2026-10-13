// Every note write compares before it overwrites: a record carries the
// version of the body its writer last saw (`bodyVersion`, as getNote gives
// it), and storage writes it only while the stored body is still at that
// version, moving it on by one. A write based on any other version is
// refused with E_NOTE_BODY_STALE and changes nothing; its writer takes the
// stored body in (a Yjs merge) and writes again, so a body written meanwhile
// on another connection is never lost. Every storage adapter answers alike.
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, type NoteRecord, type StorageAdapter } from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))
afterAll(restoreLocalStorage)

const ID = '0192a6f0-0000-7000-8000-000000000001'
const HLC = '0001728000000000-0000-node'
const LATER = '0001728000000009-0000-node'

/** The note with `doc`'s body (its Markdown and Yjs state). */
const withBody = (note: NoteRecord, doc: Y.Doc): NoteRecord => ({
  ...note,
  bodyMd: doc.getText(BODY).toString(),
  ydoc: Y.encodeStateAsUpdate(doc),
})

/** A note whose body is `text`, written over body version 0 unless `change` says otherwise. */
function record(text: string, change: Partial<NoteRecord> = {}): NoteRecord {
  const doc = new Y.Doc()
  doc.getText(BODY).insert(0, text)
  return {
    ...withBody(
      {
        id: ID,
        title: 'Plan',
        titleHlc: HLC,
        bodyMd: '',
        ydoc: Uint8Array.of(0, 0),
        bodyVersion: 0,
        bookId: null,
        bookHlc: '',
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        createdAt: 1,
        updatedAt: 2,
        deletedAt: null,
        deletedHlc: null,
      },
      doc,
    ),
    ...change,
  }
}

/** A Yjs document holding the stored note's body. */
function docOf(note: NoteRecord) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, note.ydoc)
  return doc
}

function sqlite(path = join(tempDir('devot-versions-'), 'devot.sqlite')) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  return storage
}

/** The UI tests' storage, on an empty localStorage of its own. */
async function memory(): Promise<StorageAdapter> {
  useMemoryLocalStorage()
  const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
  return memoryStorage
}

const ADAPTERS: [string, () => StorageAdapter | Promise<StorageAdapter>][] = [
  ['SQLite', () => sqlite()],
  ['UI tests’ memory', memory],
]

describe.each(ADAPTERS)('note writes in the %s adapter', (_, make) => {
  it('store a new note at body version 1 and move it on with each write based on it', async () => {
    const storage = await make()
    await storage.putNote(record('one'))
    expect((await storage.getNote(ID))?.bodyVersion).toBe(1)

    await storage.putNote(record('one two', { bodyVersion: 1 }))
    expect(await storage.getNote(ID)).toMatchObject({ bodyMd: 'one two', bodyVersion: 2 })
    // In the Trash too.
    await storage.putNote(record('one two', { bodyVersion: 2, deletedAt: 3, deletedHlc: LATER }))
    expect(await storage.getNote(ID, { trashed: true })).toMatchObject({ bodyVersion: 3 })
  })

  it('refuse a write based on another body version, and leave a purged note alone', async () => {
    const storage = await make()
    await storage.putNote(record('one'))
    await storage.putNote(record('one two', { bodyVersion: 1 }))

    // Based on version 1, which a write has moved on from: refused whole,
    // its newer title and pin with it.
    const stale = record('one three', {
      bodyVersion: 1,
      title: 'Late',
      titleHlc: LATER,
      pinned: true,
      pinnedHlc: LATER,
    })
    await expect(storage.putNote(stale)).rejects.toThrow('E_NOTE_BODY_STALE')
    // Based on a version storage never had.
    await expect(storage.putNote(record('one four', { bodyVersion: 7 }))).rejects.toThrow(
      'E_NOTE_BODY_STALE',
    )
    expect(await storage.getNote(ID)).toMatchObject({
      title: 'Plan',
      bodyMd: 'one two',
      pinned: false,
      bodyVersion: 2,
    })

    // A purge is final: a write to a purged note is left alone, whatever its version.
    await storage.purgeNote(ID, 5, LATER)
    await storage.putNote(record('revived', { bodyVersion: 0 }))
    await storage.putNote(record('revived', { bodyVersion: 2 }))
    expect(await storage.getNote(ID, { trashed: true })).toBeNull()
  })
})

describe('a body written on another connection between a read and the write based on it', () => {
  it('makes that write fail, and the write made again after a merge keeps both', async () => {
    const path = join(tempDir('devot-versions-'), 'devot.sqlite')
    const window = sqlite(path)
    const other = sqlite(path)
    await window.putNote(record('middle'))

    // The window reads the note and types at its start...
    const read = (await window.getNote(ID))!
    const mine = docOf(read)
    mine.getText(BODY).insert(0, 'start ')
    // ...while the other connection writes at its end.
    const before = (await other.getNote(ID))!
    const theirs = docOf(before)
    theirs.getText(BODY).insert(theirs.getText(BODY).length, ' end')
    await other.putNote(withBody(before, theirs))

    await expect(window.putNote(withBody(read, mine))).rejects.toThrow('E_NOTE_BODY_STALE')
    expect((await window.getNote(ID))?.bodyMd).toBe('middle end')

    // The window takes in what is stored and writes again.
    const stored = (await window.getNote(ID))!
    Y.applyUpdate(mine, stored.ydoc)
    await window.putNote(withBody(stored, mine))
    expect(await window.getNote(ID)).toMatchObject({ bodyMd: 'start middle end', bodyVersion: 3 })
  })
})
