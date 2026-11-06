// A page of the note list, list rows by ID and bodies by ID: each one read, the same in the
// SQLite adapter (the Rust store's statements) and the UI tests' memory storage.
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NoteRecord, StorageAdapter, TagRecord } from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

afterAll(restoreLocalStorage)

const id = (n: number) => `0192a6f0-0000-7000-8000-${String(n).padStart(12, '0')}`
const BOOK = '0192a6f0-0000-7000-9000-000000000001'
const OTHER_BOOK = '0192a6f0-0000-7000-9000-000000000002'
const TAG = '0192a6f0-0000-7000-a000-000000000001'
const HLC = '0001728000000000-0000-node'

function record(n: number, change: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: id(n),
    title: `Note ${n}`,
    titleHlc: HLC,
    bodyMd: `Body ${n}`,
    ydoc: Uint8Array.of(0, 0),
    bodyVersion: 0,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: n,
    updatedAt: n,
    deletedAt: null,
    deletedHlc: null,
    ...change,
  }
}

const tag: TagRecord = {
  id: TAG,
  name: 'plan',
  nameHlc: HLC,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  deletedHlc: null,
  color: null,
  colorHlc: '',
}

const adapters: [string, () => Promise<StorageAdapter>][] = [
  ['SQLite', async () => openSqliteAdapter(join(tempDir('devot-list-reads-'), 'devot.sqlite'))],
  [
    'memory',
    async () => {
      useMemoryLocalStorage()
      return (await import('../../src/renderer/src/storage/memory')).memoryStorage
    },
  ],
]

describe.each(adapters)('%s storage list reads', (_name, open) => {
  let storage: StorageAdapter

  /** Notes 1 to 6, newest last: 2 and 5 in BOOK, 3 in OTHER_BOOK, 4 trashed, 6 purged; 1 tagged. */
  beforeEach(async () => {
    storage = await open()
    await storage.putTag(tag)
    await storage.putNote(record(1))
    await storage.putNote(record(2, { bookId: BOOK, bookHlc: HLC }))
    await storage.putNote(record(3, { bookId: OTHER_BOOK, bookHlc: HLC }))
    await storage.putNote(record(4, { deletedAt: 10, deletedHlc: HLC }))
    await storage.putNote(record(5, { bookId: BOOK, bookHlc: HLC }))
    await storage.putNote(record(6, { deletedAt: 11, deletedHlc: HLC }))
    await storage.purgeNote(id(6), 12, '0001728000000009-0000-node')
    await storage.putNoteTag({
      noteId: id(1),
      tagId: TAG,
      present: true,
      hlc: HLC,
    })
  })

  afterEach(() => {
    if ('close' in storage && typeof storage.close === 'function') storage.close()
  })

  const ids = (notes: readonly { id: string }[]) => notes.map((n) => n.id)

  it('lists every live note without a page, and a page outside a notebook with one', async () => {
    expect(ids(await storage.listNotes())).toEqual([id(5), id(3), id(2), id(1)])
    expect(ids(await storage.listNotes({ limit: 2 }))).toEqual([id(5), id(3)])
    expect(ids(await storage.listNotes({ excludeBookId: BOOK }))).toEqual([id(3), id(1)])
    // The limit counts what is left once the notebook is out.
    expect(ids(await storage.listNotes({ excludeBookId: BOOK, limit: 1 }))).toEqual([id(3)])
    expect(await storage.listNotes({ limit: 0 })).toEqual([])
  })

  it('reads the list rows of the live notes asked for, in list order', async () => {
    const rows = await storage.getSummaries([id(1), id(4), id(6), id(9), id(5)])
    expect(rows).toEqual(
      (await storage.listNotes()).filter((n) => n.id === id(5) || n.id === id(1)),
    )
    expect(rows[1]?.tagIds).toEqual([TAG])
    expect(await storage.getSummaries([])).toEqual([])
  })

  it('reads the bodies asked for in their order, trashed ones too, never a purged one', async () => {
    expect(await storage.getBodies([id(4), id(6), id(9), id(1)])).toEqual([
      { id: id(4), title: 'Note 4', bodyMd: 'Body 4' },
      { id: id(1), title: 'Note 1', bodyMd: 'Body 1' },
    ])
    expect(await storage.getBodies([])).toEqual([])
  })
})
