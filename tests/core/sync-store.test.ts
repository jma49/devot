import { readdirSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService, MERGE } from '../../src/core'
import { openSqliteAdapter, SYNC_SQL, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
const pendingIds = async (storage: SqliteAdapter) =>
  (await storage.syncPending('', 10)).map((row) => row.id)
afterEach(() => open.splice(0).forEach((a) => a.close()))

function sqlite() {
  const storage = openSqliteAdapter(join(tempDir('devot-sync-store-'), 'db.sqlite'))
  open.push(storage)
  return storage
}

it('marks every write of a note, its tags, a notebook or a tag pending until looked at', async () => {
  const storage = sqlite()
  const clock = createClock('mac')
  const notes = createNoteService({ storage, clock, newId: createIdGenerator(), saveDelayMs: 5 })
  const id = await notes.create('One')
  await notes.flush()
  expect(await pendingIds(storage)).toEqual([id])
  expect(await storage.syncPendingCount()).toBe(1)
  const [row] = await storage.syncRead([id])
  expect(row?.entry).toMatchObject({ kind: 'note', version: 0, synced: 0 })
  await storage.syncPut({ ...row!.entry!, version: 4, fingerprint: 'f', synced: row!.entry!.edits })
  expect(await pendingIds(storage)).toEqual([])
  expect(await storage.syncPendingCount()).toBe(0)
  await notes.setPinned(id, true)
  await notes.flush()
  expect(await pendingIds(storage)).toEqual([id])
  expect((await storage.syncRead([id]))[0]?.entry?.version).toBe(4)
  await storage.syncReset()
  expect((await storage.syncRead([id]))[0]?.entry).toMatchObject({ version: 0, fingerprint: '' })
})

it('purges a note from sync keeping its revisions', async () => {
  const storage = sqlite()
  const notes = createNoteService({
    storage,
    clock: createClock('mac'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  const id = await notes.create('Gone')
  await notes.flush()
  const note = (await storage.getNote(id))!
  await storage.putRevision({
    id: '0192a6f0-0000-7000-8000-0000000000f1',
    noteId: id,
    kind: 'body',
    at: 1,
    ydoc: note.ydoc,
    length: 0,
    value: MERGE,
    words: null,
  })
  await storage.syncPurge(id, 5, '0000000000000005-0000-mac')
  const [row] = await storage.syncRead([id])
  expect(row?.note?.purged).toBe(true)
  expect((await storage.listRevisions(id)).map((r) => r.value)).toEqual([MERGE])
})

it('gives each pending record’s edits, so the engine skips one it stamped already', async () => {
  const storage = sqlite()
  const notes = createNoteService({
    storage,
    clock: createClock('mac'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  const id = await notes.create('One')
  await notes.flush()
  const [pending] = await storage.syncPending('', 10)
  const [row] = await storage.syncRead([id])
  expect(pending).toEqual({ id, edits: row?.entry?.edits, uploadKey: expect.any(String) })
})

it('keys each record for upload at random, after the ID, and draws the keys again for a new epoch', async () => {
  const storage = sqlite()
  const notes = createNoteService({
    storage,
    clock: createClock('mac'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  for (let i = 0; i < 20; i += 1) await notes.create(`Note ${i}`)
  await notes.flush()
  const keys = async () =>
    new Map((await storage.syncPending('', 100)).map((p) => [p.id, p.uploadKey]))
  const first = await keys()
  for (const [id, key] of first) expect(key).toMatch(new RegExp(`^[0-9a-f]{16}${id}$`))
  await storage.syncReset()
  const again = await keys()
  expect([...again.keys()].sort()).toEqual([...first.keys()].sort())
  for (const [id, key] of again) expect(key).not.toBe(first.get(id))
})

it('keys the records of a library from before schema v28 for upload, each at random', async () => {
  const dir = join(import.meta.dirname, '../../src-tauri/migrations')
  const migrations = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
  const path = join(tempDir('devot-sync-store-v27-'), 'db.sqlite')
  const db = new Database(path)
  db.function('devot_fold', { deterministic: true }, (text) => text)
  migrations.slice(0, 27).forEach((sql, i) => {
    db.exec(sql)
    db.pragma(`user_version = ${i + 1}`)
  })
  const ids = Array.from(
    { length: 12 },
    (_, i) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`,
  )
  const insert = db.prepare(`INSERT INTO sync_records (id, kind) VALUES (?, 'book')`)
  for (const id of ids) insert.run(id)
  db.close()
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const pending = await storage.syncPending('', 100)
  expect(pending.map((p) => p.id).sort()).toEqual(ids)
  for (const p of pending) expect(p.uploadKey).toMatch(new RegExp(`^[0-9a-f]{16}${p.id}$`))
  expect(new Set(pending.map((p) => p.uploadKey.slice(0, 16))).size).toBe(ids.length)
})

it('passes an attachment on only to a newer owner, as the merge orders them', async () => {
  const storage = sqlite()
  const notes = createNoteService({
    storage,
    clock: createClock('mac'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  const [low, high] = [await notes.create('One'), await notes.create('Two')].sort()
  await notes.flush()
  const file = {
    id: '0192a6f0-0000-7000-8000-00000000f001',
    name: 'board.png',
    mime: 'image/png',
    size: 3,
    createdAt: 1,
  }
  const data = new Uint8Array([1, 2, 3])
  const owner = async () => {
    const [row] = await storage.syncRead([file.id])
    return [row?.file?.noteId, row?.file?.noteHlc]
  }
  const newer = '0000000000000009-0000-mac'
  const older = '0000000000000005-0000-mac'
  await storage.syncFilePut({ ...file, noteId: low!, noteHlc: '' }, data)
  await storage.syncFilePut({ ...file, noteId: high!, noteHlc: newer }, data)
  expect(await owner()).toEqual([high, newer])
  // A local hand-over that landed between the engine's read and its write keeps the file.
  await storage.syncFilePut({ ...file, noteId: low!, noteHlc: older }, data)
  expect(await owner()).toEqual([high, newer])
  await storage.syncFilePut({ ...file, noteId: low!, noteHlc: newer }, data)
  expect(await owner()).toEqual([high, newer])
  storage.db.prepare(`UPDATE files SET note_id = ? WHERE id = ?`).run(low, file.id)
  await storage.syncFilePut({ ...file, noteId: high!, noteHlc: newer }, data)
  expect(await owner()).toEqual([high, newer])
})

it('reads and counts pending records from the partial index', () => {
  const storage = sqlite()
  const plan = (sql: string, params: object = {}) =>
    (storage.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[])
      .map((p) => p.detail)
      .join('\n')
  expect(plan(SYNC_SQL.pending, { after: '', limit: 1 })).toMatch(
    /USING (COVERING )?INDEX sync_pending/,
  )
  expect(plan(SYNC_SQL.pendingCount)).toMatch(/USING (COVERING )?INDEX sync_pending/)
})

it('runs the same statements as the Rust store', () => {
  const source = readFileSync('src-tauri/src/storage/sync.rs', 'utf8')
  const statement = (name: string) =>
    new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1] ?? ''
  const words = (sql: string) => sql.split(/\s+/).join(' ')
  const names = {
    pending: 'SYNC_PENDING_SQL',
    pendingCount: 'SYNC_PENDING_COUNT_SQL',
    entry: 'SYNC_ENTRY_SQL',
    put: 'SYNC_PUT_SQL',
    state: 'SYNC_STATE_SQL',
    setState: 'SYNC_SET_STATE_SQL',
    reset: 'SYNC_RESET_SQL',
    noteTags: 'SYNC_NOTE_TAGS_SQL',
    file: 'SYNC_FILE_SQL',
    fileData: 'SYNC_FILE_DATA_SQL',
    filePut: 'SYNC_FILE_PUT_SQL',
    fileDelete: 'SYNC_FILE_DELETE_SQL',
  } as const
  const keys = Object.keys(names) as (keyof typeof names)[]
  const rust = Object.fromEntries(keys.map((k) => [k, words(statement(names[k]))]))
  const ours = Object.fromEntries(keys.map((k) => [k, words(SYNC_SQL[k])]))
  expect(rust).toEqual(ours)
  expect(Object.values(rust).filter((sql) => sql === '')).toEqual([])
})
