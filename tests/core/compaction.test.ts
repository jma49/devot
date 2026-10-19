// Real SQLite: sweeps run on their own queue, resume where the last left off (also in a new session),
// weigh the library in few storage calls, and list/delete from indexes that never read Yjs state.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BASELINE,
  BODY,
  COMPACT_BATCH,
  COMPACT_PAGE,
  createClock,
  createIdGenerator,
  createNoteService,
  KEEP_NEWEST,
  type NoteRecord,
  type NoteService,
  type RevisionRecord,
  type StorageAdapter,
} from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { openSqliteAdapter, REVISION_SQL, type SqliteAdapter } from '../support/sqlite-adapter'
import { watchSweeps } from '../support/sweeps'
import { tempDir } from '../support/temp-dirs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
// Noon UTC: the versions below fall on one local day in any time zone.
const NOW = Date.UTC(2026, 9, 12, 12)
// Injected clock; timers are faked to follow it.
let time = NOW

const open: SqliteAdapter[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  time = NOW
})
afterEach(() => {
  vi.useRealTimers()
  open.splice(0).forEach((a) => a.close())
})
afterAll(restoreLocalStorage)

const freshPath = () => join(tempDir('devot-compaction-'), 'devot.sqlite')

function sqlite(path = freshPath()) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  return storage
}

function service(storage: StorageAdapter) {
  return createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    now: () => time,
    saveDelayMs: 300,
  })
}

async function type(notes: NoteService, noteId: string, text: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(noteId)).state)
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  doc.transact(() => {
    const body = doc.getText(BODY)
    body.delete(0, body.length)
    body.insert(0, text)
  })
  for (const u of updates) await notes.applyUpdate(noteId, u)
  time += 300
  await vi.advanceTimersByTimeAsync(300)
}

async function finishes(work: Promise<unknown>) {
  const state = { done: false }
  void work.then(() => (state.done = true))
  for (let turn = 0; turn < 20; turn += 1) {
    if (state.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  return state.done
}

const id = (n: number) => `0192a6f0-0000-7000-8000-${String(n).padStart(12, '0')}`

async function putNote(storage: StorageAdapter, noteId: string) {
  await storage.putNote({
    id: noteId,
    title: '',
    titleHlc: '0001728000000000-0000-test',
    bodyMd: '',
    ydoc: new Uint8Array([0, 0]),
    bodyVersion: 0,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    deletedHlc: null,
  })
}

const version = (n: number, noteId: string, at: number, value: string | null = null) =>
  ({
    id: id(n),
    noteId,
    kind: 'body',
    at,
    ydoc: new Uint8Array([0, 0]),
    length: 0,
    value,
  }) satisfies RevisionRecord

const event = (n: number, noteId: string, at: number) =>
  ({
    id: id(n),
    noteId,
    kind: 'title',
    at,
    ydoc: null,
    length: null,
    value: 'T',
  }) satisfies RevisionRecord

/** a: two versions, one in 200..300; b: one before 300, one after; c: two before 200; d: one version and an event; e: one beside a baseline, which compaction keeps. */
async function world(storage: StorageAdapter) {
  const [a, b, c, d, e] = [id(901), id(902), id(903), id(904), id(905)]
  for (const note of [a, b, c, d, e]) await putNote(storage, note)
  const rows = [
    version(1, a, 100),
    version(2, a, 250),
    version(3, b, 250),
    version(4, b, 400),
    version(5, c, 100),
    version(6, c, 150),
    version(7, d, 250),
    event(8, d, 260),
    version(9, e, 100, BASELINE),
    version(10, e, 250),
  ]
  for (const row of rows) await storage.putRevision(row)
  return { a, b, c, d, e }
}

describe('the storage a compaction sweep uses', () => {
  it('lists every plain version of the notes a sweep weighs, baselines left out', async () => {
    const storage = sqlite()
    const { a, b, c } = await world(storage)
    const listed = async (from: number, to: number) =>
      (await storage.listCompactable(from, to, '', 500)).map((v) => `${v.noteId}/${v.id}@${v.at}`)
    // Each note's versions, newest first; e's baseline does not make two.
    expect(await listed(200, 300)).toEqual([`${a}/${id(2)}@250`, `${a}/${id(1)}@100`])
    expect(await listed(0, 300)).toEqual([
      `${a}/${id(2)}@250`,
      `${a}/${id(1)}@100`,
      `${c}/${id(6)}@150`,
      `${c}/${id(5)}@100`,
    ])
    expect(await listed(0, 500)).toEqual([
      `${a}/${id(2)}@250`,
      `${a}/${id(1)}@100`,
      `${b}/${id(4)}@400`,
      `${b}/${id(3)}@250`,
      `${c}/${id(6)}@150`,
      `${c}/${id(5)}@100`,
    ])
    expect(await listed(300, 500)).toEqual([`${b}/${id(4)}@400`, `${b}/${id(3)}@250`])
  })

  it('lists a page of notes at a time, by ID', async () => {
    const storage = sqlite()
    const { a, b, c } = await world(storage)
    const page = async (after: string, limit: number) => [
      ...new Set((await storage.listCompactable(0, 500, after, limit)).map((v) => v.noteId)),
    ]
    expect(await page('', 1)).toEqual([a])
    expect(await page(a, 2)).toEqual([b, c])
    expect(await page(c, 2)).toEqual([])
    expect(await storage.listCompactable(0, 500, a, 1)).toHaveLength(2)
  })

  it('deletes only plain versions, and records when the last sweep ran', async () => {
    const storage = sqlite()
    const { a, d, e } = await world(storage)
    expect(await storage.lastCompaction()).toBeNull()
    await storage.compactRevisions([id(1), id(8), id(9), id(999)], null)
    expect((await storage.listRevisions(a)).map((r) => r.id)).toEqual([id(2)])
    expect((await storage.listRevisions(d)).map((r) => r.id)).toEqual([id(8), id(7)])
    expect((await storage.listRevisions(e)).map((r) => r.id)).toEqual([id(10), id(9)])
    expect(await storage.lastCompaction()).toBeNull()
    await storage.compactRevisions([], 5000)
    expect(await storage.lastCompaction()).toBe(5000)
    // A clock set back records the earlier time: the next sweep starts there.
    await storage.compactRevisions([id(2)], 4000)
    expect(await storage.lastCompaction()).toBe(4000)
    expect(await storage.listRevisions(a)).toEqual([])
  })

  it('reads history and compaction from covering indexes, never a Yjs state', () => {
    const storage = sqlite()
    const plan = (sql: string) =>
      (
        storage.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all({ from: 0, to: 1, after: '', limit: 1, noteId: 'n' }) as { detail: string }[]
      )
        .map((p) => p.detail)
        .join('\n')
    const history = plan(REVISION_SQL.history)
    expect(history).toBe('SEARCH revisions USING COVERING INDEX revisions_history (note_id=?)')
    const compactable = plan(REVISION_SQL.compactable)
    expect(compactable).toMatch(
      /SEARCH revisions USING COVERING INDEX revisions_by_time \(at>\? AND at<\?\)/,
    )
    expect(compactable).toMatch(
      /SEARCH p USING COVERING INDEX revisions_history \(note_id=\? AND at<\?\)/,
    )
    expect(compactable).toMatch(
      /SEARCH revisions USING COVERING INDEX revisions_history \(note_id=\?\)/,
    )
    expect(compactable.match(/(SCAN|SEARCH) (revisions|p)\b(?! USING COVERING INDEX)/)).toBeNull()
  })

  it('runs the same statements as the Rust store', () => {
    const source = readFileSync('src-tauri/src/storage/mod.rs', 'utf8')
    const statement = (name: string) =>
      new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1] ?? ''
    const words = (sql: string) => sql.split(/\s+/).join(' ')
    const names: Record<keyof typeof REVISION_SQL, string> = {
      history: 'REVISION_HISTORY_SQL',
      compactable: 'COMPACTABLE_SQL',
      compactDrop: 'COMPACT_DROP_SQL',
      compactSwept: 'COMPACT_SWEPT_SQL',
      lastCompaction: 'LAST_COMPACTION_SQL',
    }
    const keys = Object.keys(names) as (keyof typeof names)[]
    const rust = Object.fromEntries(keys.map((k) => [k, words(statement(names[k]))]))
    const ours = Object.fromEntries(keys.map((k) => [k, words(REVISION_SQL[k])]))
    expect(rust).toEqual(ours)
    expect(Object.values(rust).filter((sql) => sql === '')).toEqual([])
  })

  it('answers alike on the UI tests’ memory storage', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    const run = async (storage: StorageAdapter) => {
      const { a, d, e } = await world(storage)
      const lists = await Promise.all(
        [
          [200, 300],
          [0, 300],
          [0, 500],
          [300, 500],
        ].map(([from, to]) => storage.listCompactable(from!, to!, '', 500)),
      )
      const pages = [
        await storage.listCompactable(0, 500, '', 2),
        await storage.listCompactable(0, 500, id(902), 2),
      ]
      const before = await storage.lastCompaction()
      await storage.compactRevisions([id(1), id(8), id(9), id(999)], 7000)
      const left = await Promise.all([a, d, e].map((note) => storage.listRevisions(note)))
      return { lists, pages, before, after: await storage.lastCompaction(), left }
    }
    const fromSqlite = await run(sqlite())
    expect(fromSqlite.after).toBe(7000)
    expect(await run(memoryStorage)).toEqual(fromSqlite)
  })
})

const record = (noteId: string): NoteRecord => ({
  id: noteId,
  title: '',
  titleHlc: '0001728000000000-0000-test',
  bodyMd: '',
  ydoc: new Uint8Array([0, 0]),
  bodyVersion: 0,
  bookId: null,
  bookHlc: '',
  status: 'none',
  statusHlc: '',
  pinned: false,
  pinnedHlc: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  deletedHlc: null,
})

/** `notes` notes, each with newest versions from the last day and two from one hour two days ago; a sweep drops the older of those two. */
function seedLibrary(storage: SqliteAdapter, notes: number) {
  const hour = Math.floor((NOW - 2 * DAY) / HOUR) * HOUR
  let n = 0
  const ids: string[] = []
  storage.db.transaction(() => {
    for (let i = 0; i < notes; i += 1) {
      const noteId = id(100_000 + i)
      ids.push(noteId)
      void storage.putNote(record(noteId))
      const times = [
        ...Array.from({ length: KEEP_NEWEST }, (_, k) => NOW - (k + 1) * 10 * MINUTE),
        hour + 40 * MINUTE,
        hour + 10 * MINUTE,
      ]
      for (const at of times) void storage.putRevision(version((n += 1), noteId, at))
    }
  })()
  return ids
}

function holdSweeps(storage: SqliteAdapter) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const calls: string[] = []
  const methods = storage as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const name of ['lastCompaction', 'listCompactable', 'compactRevisions']) {
    const real = methods[name]!.bind(storage)
    methods[name] = async (...args: unknown[]) => {
      calls.push(name)
      await gate
      return real(...args)
    }
  }
  return { calls, open: () => release() }
}

describe('compaction sweeps', () => {
  it('let saves, History, Activity, the Trash and quitting finish while a 1,000-note sweep runs', async () => {
    const storage = sqlite()
    const library = seedLibrary(storage, 1000)
    const sweeps = watchSweeps(storage)
    const held = holdSweeps(storage)
    const notes = service(storage)
    const today = await notes.create('Today')
    const other = await notes.create('Other')
    await type(notes, today, 'first edit')
    expect(held.calls).toEqual(['lastCompaction'])

    await type(notes, today, 'second edit')
    expect(await finishes(notes.flush())).toBe(true)
    expect(await finishes(notes.history(today))).toBe(true)
    expect(await finishes(notes.activity(time))).toBe(true)
    expect(await finishes(notes.trash(other))).toBe(true)
    await type(notes, today, 'last words')
    expect(await finishes(notes.flush({ versions: true }))).toBe(true)
    const [quitVersion] = (await storage.listRevisions(today)).filter((r) => r.kind === 'body')
    expect(quitVersion?.length).toBe('last words'.length)

    held.open()
    await sweeps.until(1)
    const count = (name: string) => held.calls.filter((call) => call === name).length
    expect(held.calls[0]).toBe('lastCompaction')
    expect(count('listCompactable')).toBe(Math.floor(library.length / COMPACT_PAGE) + 1)
    expect(count('compactRevisions')).toBe(Math.floor(library.length / COMPACT_BATCH) + 1)
    expect(held.calls.at(-1)).toBe('compactRevisions')
    for (const noteId of [library[0]!, library.at(-1)!]) {
      const left = await storage.listRevisions(noteId)
      expect(left).toHaveLength(KEEP_NEWEST + 1)
      expect(left.at(-1)?.at).toBe(Math.floor((NOW - 2 * DAY) / HOUR) * HOUR + 40 * MINUTE)
    }
    const total = storage.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }
    const mine = (await storage.listRevisions(today)).length
    expect(total.n).toBe(library.length * (KEEP_NEWEST + 1) + mine)
    expect(await storage.lastCompaction()).toBe(NOW + 300)
  })

  it('start where the last one left off, in a new session too', async () => {
    const path = freshPath()
    const first = sqlite(path)
    seedLibrary(first, 3)
    const firstSweeps = watchSweeps(first)
    const notes = service(first)
    const id1 = await notes.create()
    await type(notes, id1, 'a')
    await firstSweeps.until(1)
    const swept = NOW + 300
    expect(await first.lastCompaction()).toBe(swept)

    time = NOW + 2 * HOUR
    const second = sqlite(path)
    const asked: [number, number][] = []
    const list = second.listCompactable.bind(second)
    second.listCompactable = (from, to, after, limit) => {
      asked.push([from, to])
      return list(from, to, after, limit)
    }
    const secondSweeps = watchSweeps(second)
    const again = service(second)
    await type(again, await again.create(), 'b')
    await secondSweeps.until(1)
    const at = NOW + 2 * HOUR + 300
    expect(asked).toEqual([
      [swept - DAY, at - DAY],
      [swept - WEEK, at - WEEK],
    ])
    expect(await second.lastCompaction()).toBe(at)
  })

  it('finish before a backup restore replaces the database, and wait for it to end', async () => {
    const storage = sqlite()
    const noteId = id(500)
    await putNote(storage, noteId)
    // Ten versions from the last hours, and two from one day ten days ago:
    // a sweep keeps that day's later one, W, and drops V.
    const recent = Array.from({ length: KEEP_NEWEST }, (_, k) =>
      version(600 + k, noteId, NOW - (k + 1) * 10 * MINUTE),
    )
    const v = version(700, noteId, NOW - 10 * DAY + 5 * MINUTE)
    const w = version(701, noteId, NOW - 10 * DAY + 50 * MINUTE)
    for (const row of [...recent, v, w]) await storage.putRevision(row)
    // The backup was taken between V and W: it has V, not W, and no sweep.
    const backup = [...recent, v]

    // Hold the sweep after its listing, at its first delete.
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sweep = { deleting: false }
    const compact = storage.compactRevisions.bind(storage)
    storage.compactRevisions = async (ids, sweptAt) => {
      sweep.deleting = true
      await gate
      return compact(ids, sweptAt)
    }
    const sweeps = watchSweeps(storage)
    const notes = service(storage)
    await type(notes, await notes.create(), 'first edit')
    for (let turn = 0; turn < 20 && !sweep.deleting; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(sweep.deleting).toBe(true)

    // As Backups runs it: save, hold compaction, replace.
    const restoring = (async () => {
      await notes.flush()
      await notes.holdCompaction()
      storage.db.prepare('DELETE FROM revisions').run()
      storage.db.prepare('DELETE FROM compaction').run()
      for (const row of backup) await storage.putRevision(row)
    })()
    expect(await finishes(restoring)).toBe(false)
    release()
    await restoring
    await sweeps.until(1)

    // The old data was weighed and thinned before the restore; restored history is whole, with no sweep time.
    const ids = (await storage.listRevisions(noteId)).map((r) => r.id)
    expect(ids.sort()).toEqual(backup.map((r) => r.id).sort())
    expect(await storage.lastCompaction()).toBeNull()

    time += 2 * HOUR
    await type(notes, await notes.create(), 'after the restore')
    expect(sweeps.count).toBe(1)
    notes.resumeCompaction()
    time += 2 * HOUR
    await type(notes, await notes.create(), 'resumed')
    await sweeps.until(2)
    expect(await storage.listRevisions(noteId)).toHaveLength(backup.length)
  })

  it('weigh every note again when the clock was set back past the last sweep', async () => {
    const storage = sqlite()
    const library = seedLibrary(storage, 2)
    // Recorded by a start whose clock ran eight days fast.
    await storage.compactRevisions([], NOW + 8 * DAY)
    const asked: [number, number][] = []
    const list = storage.listCompactable.bind(storage)
    storage.listCompactable = (from, to, after, limit) => {
      asked.push([from, to])
      return list(from, to, after, limit)
    }
    const sweeps = watchSweeps(storage)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notes = service(storage)
    await type(notes, await notes.create(), 'set right')
    await sweeps.until(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(asked).toEqual([[0, NOW + 300 - DAY]])
    expect(await storage.listRevisions(library[0]!)).toHaveLength(KEEP_NEWEST + 1)
    expect(await storage.lastCompaction()).toBe(NOW + 300)
  })
})
