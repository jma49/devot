import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { observeWrites } from '../../src/core/observeWrites'
import { fromWire, toWire } from '../../src/renderer/src/storage/wire'
import { tempSqliteAdapter } from '../support/sqlite-adapter'

it('empties Trash through the wire in one atomic storage write, then relays each note', async () => {
  const sqlite = tempSqliteAdapter('devot-purge-batch-')
  const writes: unknown[] = []
  const relayed: unknown[] = []
  const storage = fromWire(toWire(observeWrites(sqlite, (ids) => writes.push(ids))))
  const notes = createNoteService({
    storage,
    clock: createClock('batch'),
    newId: createIdGenerator(),
    relay: (message) => relayed.push(message),
    compact: false,
  })
  const ids = [await notes.create('One'), await notes.create('Two')]
  for (const id of ids) await notes.trash(id)
  const order = (await sqlite.listTrash()).map((note) => note.id)
  writes.length = 0
  relayed.length = 0
  expect(await notes.emptyTrash()).toBe(2)
  expect(writes).toHaveLength(1)
  expect(relayed).toEqual(order.map((noteId) => ({ kind: 'gone', noteId, purged: true })))
  expect(await sqlite.listTrash()).toEqual([])
  expect(await notes.emptyTrash()).toBe(0)
  expect(writes).toHaveLength(1)
})

it('rolls back a batch that includes a live note and leaves secure-delete off', async () => {
  const s = tempSqliteAdapter('devot-purge-batch-')
  s.db
    .exec(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at)
    VALUES ('a', 'Trash', '', 'orchard', x'00', 1, 1, 2),
           ('b', 'Live', '', 'snapshot', x'00', 1, 1, NULL)`)
  s.catchUpSearchIndex()
  s.db.exec("INSERT INTO notes_fts (notes_fts, rank) VALUES ('secure-delete', 0)")
  await expect(s.purgeNotes(['a', 'b'], 3, '0000000000000003-0000-batch')).rejects.toThrow(
    'E_NOTE_NOT_TRASHED',
  )
  expect((await s.listTrash()).map((n) => n.id)).toEqual(['a'])
  expect(
    (s.db.prepare('SELECT body_md FROM notes WHERE id = ?').get('a') as { body_md: string })
      .body_md,
  ).toBe('orchard')
  expect(s.db.prepare("SELECT v FROM notes_fts_config WHERE k = 'secure-delete'").get()).toEqual({
    v: 0,
  })
  s.db.exec("UPDATE notes SET deleted_at = 2 WHERE id = 'b'")
  await s.purgeNotes(['missing', 'a', 'a', 'b'], 3, '0000000000000003-0000-batch')
  expect(await s.listTrash()).toEqual([])
})

async function largeTrash(count: number) {
  const sqlite = tempSqliteAdapter('devot-purge-chunks-')
  const newId = createIdGenerator()
  const insert = sqlite.db.prepare(
    "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at) VALUES (?, 'Trash', '', '', x'00', 1, 1, 2)",
  )
  sqlite.db.transaction(() => {
    for (let n = 0; n < count; n++) insert.run(newId())
  })()
  const committed: string[][] = []
  const relayed: unknown[] = []
  const storage = fromWire(
    toWire({
      ...sqlite,
      async purgeNotes(ids, at, hlc) {
        await sqlite.purgeNotes(ids, at, hlc)
        committed.push([...ids])
      },
    }),
  )
  const notes = createNoteService({
    storage,
    clock: createClock('chunks'),
    newId,
    relay: (message) => relayed.push(message),
    compact: false,
  })
  return {
    sqlite,
    notes,
    committed,
    relayed,
    order: (await sqlite.listTrash()).map((note) => note.id),
  }
}

it('empties more than 500 trashed notes in bounded batches through the wire', async () => {
  const { sqlite, notes, committed, relayed, order } = await largeTrash(1001)
  expect(await notes.emptyTrash()).toBe(1001)
  expect(committed.map((ids) => ids.length)).toEqual([500, 500, 1])
  expect(committed.flat()).toEqual(order)
  expect(relayed).toEqual(order.map((noteId) => ({ kind: 'gone', noteId, purged: true })))
  expect(await sqlite.listTrash()).toEqual([])
})

it('relays completed chunks but leaves a failed chunk unpurged and unannounced', async () => {
  const { sqlite, notes, committed, relayed, order } = await largeTrash(501)
  sqlite.db.exec(
    `CREATE TRIGGER refuse_purge BEFORE UPDATE OF purged_at ON notes WHEN new.id = '${order[500]}' BEGIN SELECT RAISE(ABORT, 'E_TEST_PURGE'); END`,
  )
  await expect(notes.emptyTrash()).rejects.toThrow('E_TEST_PURGE')
  expect(committed).toEqual([order.slice(0, 500)])
  expect(relayed).toEqual(
    order.slice(0, 500).map((noteId) => ({ kind: 'gone', noteId, purged: true })),
  )
  expect((await sqlite.listTrash()).map((note) => note.id)).toEqual(order.slice(500))
})

it('rolls back all purges on a database error without relaying any note', async () => {
  const s = tempSqliteAdapter('devot-purge-batch-')
  const relayed: unknown[] = []
  const notes = createNoteService({
    storage: s,
    clock: createClock('batch'),
    newId: createIdGenerator(),
    relay: (message) => relayed.push(message),
    compact: false,
  })
  const ids = [await notes.create('One'), await notes.create('Two')]
  for (const id of ids) await notes.trash(id)
  s.db.exec(`CREATE TRIGGER refuse_purge BEFORE UPDATE OF purged_at ON notes
    WHEN new.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'E_TEST_PURGE'); END`)
  relayed.length = 0
  await expect(notes.emptyTrash()).rejects.toThrow('E_TEST_PURGE')
  expect((await s.listTrash()).map((n) => n.id).sort()).toEqual([...ids].sort())
  expect(relayed).toEqual([])
})

it('removes every purged trigram and old version from the file while preserving retained matches', async () => {
  const s = tempSqliteAdapter('devot-purge-batch-')
  const secret = 'qxjzvwkpfyb'
  s.db
    .prepare(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at)
    VALUES ('a', '', '', ?, x'00', 1, 1, 2), ('b', '', '', ?, x'00', 1, 1, 2), ('kept', '', '', 'orchard', x'00', 1, 1, NULL)`)
    .run(secret.repeat(400), secret.repeat(400))
  s.catchUpSearchIndex()
  s.db.exec("UPDATE notes SET body_md = 'snapshot' WHERE id = 'a'")
  s.catchUpSearchIndex()
  await s.purgeNotes(['a', 'b'], 3, '0000000000000003-0000-batch')
  s.db.exec("CREATE VIRTUAL TABLE temp.purge_vocab USING fts5vocab(main, notes_fts, 'row')")
  for (let i = 0; i < secret.length - 2; i++) {
    const term = secret.slice(i, i + 3)
    expect(s.db.prepare('SELECT term FROM purge_vocab WHERE term = ?').all(term)).toEqual([])
    expect(s.db.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?').all(term)).toEqual(
      [],
    )
  }
  expect(
    s.db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'orchard'").all(),
  ).toHaveLength(1)
  s.db.pragma('wal_checkpoint(TRUNCATE)')
  const bytes = readFileSync(s.db.name)
  for (let i = 0; i < secret.length - 2; i++)
    expect(bytes.includes(secret.slice(i, i + 3))).toBe(false)
})
