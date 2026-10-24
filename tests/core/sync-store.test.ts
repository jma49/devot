import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService, MERGE } from '../../src/core'
import { openSqliteAdapter, SYNC_SQL, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
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
  expect(await storage.syncPending('', 10)).toEqual([id])
  const [row] = await storage.syncRead([id])
  expect(row?.entry).toMatchObject({ kind: 'note', version: 0, synced: 0 })
  await storage.syncPut({ ...row!.entry!, version: 4, fingerprint: 'f', synced: row!.entry!.edits })
  expect(await storage.syncPending('', 10)).toEqual([])
  await notes.setPinned(id, true)
  await notes.flush()
  expect(await storage.syncPending('', 10)).toEqual([id])
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
  })
  await storage.syncPurge(id, 5, '0000000000000005-0000-mac')
  const [row] = await storage.syncRead([id])
  expect(row?.note?.purged).toBe(true)
  expect((await storage.listRevisions(id)).map((r) => r.value)).toEqual([MERGE])
})

it('reads pending records from the partial index', () => {
  const storage = sqlite()
  const plan = storage.db
    .prepare(`EXPLAIN QUERY PLAN ${SYNC_SQL.pending}`)
    .all({ after: '', limit: 1 }) as { detail: string }[]
  expect(plan.map((p) => p.detail).join('\n')).toMatch(/USING (COVERING )?INDEX sync_pending/)
})

it('runs the same statements as the Rust store', () => {
  const source = readFileSync('src-tauri/src/storage/sync.rs', 'utf8')
  const statement = (name: string) =>
    new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1] ?? ''
  const words = (sql: string) => sql.split(/\s+/).join(' ')
  const names = {
    pending: 'SYNC_PENDING_SQL',
    entry: 'SYNC_ENTRY_SQL',
    put: 'SYNC_PUT_SQL',
    state: 'SYNC_STATE_SQL',
    setState: 'SYNC_SET_STATE_SQL',
    reset: 'SYNC_RESET_SQL',
    noteTags: 'SYNC_NOTE_TAGS_SQL',
  } as const
  const keys = Object.keys(names) as (keyof typeof names)[]
  const rust = Object.fromEntries(keys.map((k) => [k, words(statement(names[k]))]))
  const ours = Object.fromEntries(keys.map((k) => [k, words(SYNC_SQL[k])]))
  expect(rust).toEqual(ours)
  expect(Object.values(rust).filter((sql) => sql === '')).toEqual([])
})
