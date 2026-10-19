// Writes wait out another writer for the busy timeout, as the Rust store's
// do: devot-mcp and the app share one database file, and a write that fails
// at once while the other writes loses what it carried (an image, a copy).
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const F1 = '0192a6f0-0000-7000-8000-00000000f001'
const F2 = '0192a6f0-0000-7000-8000-00000000f002'
const HOLD_MS = 250

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

// Another connection, on a thread of its own, holds the write lock for a
// while and then commits; a write here waits on the main thread meanwhile.
const HOLDER = `
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.module)
const db = new Database(workerData.path)
db.exec('BEGIN IMMEDIATE')
parentPort.postMessage('held')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.hold)
db.exec('COMMIT')
db.close()
`

/**
 * Starts another writer on `path`; resolves once it holds the lock, with
 * its commit (in an object: an async function would wait for a promise).
 */
async function anotherWriter(path: string): Promise<{ committed: Promise<void> }> {
  const module = createRequire(import.meta.url).resolve('better-sqlite3')
  const worker = new Worker(HOLDER, { eval: true, workerData: { module, path, hold: HOLD_MS } })
  const committed = new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return { committed }
}

const record = (id: string, title: string) => ({
  id,
  title,
  titleHlc: `0000000000000010-0000-${id}`,
  bodyMd: '',
  ydoc: new Uint8Array([0, 0]),
  bodyVersion: 0,
  bookId: null,
  bookHlc: '',
  status: 'none' as const,
  statusHlc: '',
  pinned: false,
  pinnedHlc: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  deletedHlc: null,
})

it('every write waits out another writer', async () => {
  const path = join(tempDir('devot-busy-'), 'devot.sqlite')
  const storage = openSqliteAdapter(path)
  open.push(storage)
  await storage.putNote(record('a', 'Source'))
  await storage.putNote(record('b', 'Copy'))
  await storage.putNote({
    ...record('c', 'Gone'),
    deletedAt: 5,
    deletedHlc: '0000000000000020-0000-c',
  })

  const writes: [string, () => Promise<unknown>][] = [
    [
      'putNote',
      () =>
        storage.putNote({
          ...record('a', 'Renamed'),
          titleHlc: '0000000000000030-0000-a',
          bodyVersion: 1,
        }),
    ],
    ['putFile', () => storage.putFile({ id: F1, noteId: 'a', name: 'shot.png' }, PNG)],
    ['copyFiles', () => storage.copyFiles('b', [{ from: F1, to: F2 }])],
    [
      'putRevision',
      () =>
        storage.putRevision({
          id: 'r',
          noteId: 'a',
          kind: 'body',
          at: 60,
          ydoc: new Uint8Array([0, 0]),
          length: 0,
          value: null,
        }),
    ],
    ['deleteRevisions', () => storage.deleteRevisions('a', ['r'])],
    ['purgeNote', () => storage.purgeNote('c', 70, '0000000000000070-0000-c')],
  ]
  for (const [name, write] of writes) {
    const writer = await anotherWriter(path)
    // Named, so a failure says which write did not wait.
    const outcome = await write().then(
      () => `${name} written`,
      (error: unknown) => `${name} failed: ${String(error)}`,
    )
    expect(outcome).toBe(`${name} written`)
    await writer.committed
  }
  const owner = storage.db.prepare('SELECT note_id AS noteId FROM files WHERE id = ?').get(F2)
  expect(owner).toEqual({ noteId: 'b' })
  expect((await storage.getNote('a'))?.title).toBe('Renamed')
})
