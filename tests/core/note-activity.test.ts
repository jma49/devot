import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  buildStrips,
  createClock,
  createIdGenerator,
  createNoteService,
  DAY_MS,
  KEEP_NEWEST,
  REVISION_PAUSE_MS,
  STRIP_DAYS,
  stripLevel,
  stripStart,
  type ActivityRevision,
  type NoteService,
  type OffsetAt,
  type StorageAdapter,
} from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { ACTIVITY_SQL, openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { watchSweeps } from '../support/sweeps'
import { tempDir } from '../support/temp-dirs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const UTC: OffsetAt = () => 0

const open: SqliteAdapter[] = []
// A Wednesday noon UTC; the injected clock, with timers faked to follow it.
const NOW = Date.UTC(2026, 9, 7, 12)
let time = NOW
const today = NOW / DAY_MS - 0.5

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  time = NOW
})
afterEach(() => {
  vi.useRealTimers()
  restoreLocalStorage()
  open.splice(0).forEach((a) => a.close())
})

async function advance(ms: number) {
  const step = 1000
  for (let left = ms; left > 0; left -= step) {
    time += Math.min(step, left)
    await vi.advanceTimersByTimeAsync(Math.min(step, left))
  }
}

function sqlite() {
  const storage = openSqliteAdapter(join(tempDir('devot-strip-'), 'db'))
  open.push(storage)
  return storage
}

function service(storage: StorageAdapter = sqlite()) {
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    now: () => time,
    saveDelayMs: 300,
  })
  return { storage, notes }
}

async function type(notes: NoteService, id: string, text: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state)
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  doc.transact(() => {
    const body = doc.getText(BODY)
    body.delete(0, body.length)
    body.insert(0, text)
  })
  for (const u of updates) await notes.applyUpdate(id, u)
  await advance(1000)
}

async function typeAndPause(notes: NoteService, id: string, text: string) {
  await type(notes, id, text)
  await advance(REVISION_PAUSE_MS + 1000)
}

const strip = async (notes: NoteService, id: string) =>
  (await notes.noteActivity([id], time, UTC))[id]!.map(({ edits, chars }) => ({ edits, chars }))

const idle = { edits: 0, chars: 0 }

const version = (noteId: string, at: number, length: number, previous: number | null) =>
  ({ noteId, kind: 'body', at, length, previous }) satisfies ActivityRevision

describe('an activity strip', () => {
  it('covers the last fourteen local days, today last', () => {
    const strips = buildStrips(['a'], [], NOW, UTC)
    expect(strips['a']!.map((d) => d.day)).toEqual(
      Array.from({ length: STRIP_DAYS }, (_, i) => today - STRIP_DAYS + 1 + i),
    )
    expect(stripStart(NOW, UTC)).toBe(today - STRIP_DAYS + 1)
  })

  it('shades by fixed steps of characters, so a day keeps its shade in any company', () => {
    expect(stripLevel(0, 0)).toBe(0)
    expect(stripLevel(1, 0)).toBe(1)
    expect(stripLevel(1, 99)).toBe(1)
    expect(stripLevel(1, 100)).toBe(2)
    expect(stripLevel(3, 500)).toBe(3)
    expect(stripLevel(2, 2000)).toBe(4)
    expect(stripLevel(2, 1_000_000)).toBe(4)
  })

  it('puts a version on the day its zone shows', () => {
    // 01:30 UTC on Wednesday: still Tuesday in Los Angeles (UTC-7 in October), and Wednesday in Kathmandu (+05:45).
    const at = Date.UTC(2026, 9, 7, 1, 30)
    const revisions = [version('a', at, 30, 10)]
    const losAngeles: OffsetAt = () => -7 * 60
    const kathmandu: OffsetAt = () => 5 * 60 + 45
    const last = (offsetAt: OffsetAt) => buildStrips(['a'], revisions, NOW, offsetAt)['a']!
    expect(last(losAngeles).at(-2)).toMatchObject({ edits: 1, chars: 20 })
    expect(last(losAngeles).at(-1)).toMatchObject({ edits: 0 })
    expect(last(kathmandu).at(-1)).toMatchObject({ edits: 1, chars: 20 })
    // 18:20 UTC is already Thursday in Kathmandu: past today, so not shown.
    const late = [version('a', Date.UTC(2026, 9, 7, 18, 20), 5, 0)]
    expect(buildStrips(['a'], late, NOW, kathmandu)['a']!.every((d) => d.edits === 0)).toBe(true)
  })

  it('follows a zone whose offset changes across the strip (DST)', () => {
    // Los Angeles left DST on 2026-11-01: UTC-7 before, UTC-8 after.
    const now = Date.UTC(2026, 10, 5, 20)
    const losAngeles: OffsetAt = (at) => (at < Date.UTC(2026, 10, 1, 9) ? -7 : -8) * 60
    const before = Date.UTC(2026, 9, 31, 6, 30) // 23:30 on Oct 30, PDT
    const after = Date.UTC(2026, 10, 2, 7, 30) // 23:30 on Nov 1, PST
    const days = buildStrips(
      ['a'],
      [version('a', before, 1, 0), version('a', after, 2, 1)],
      now,
      losAngeles,
    )['a']!
    const local = (y: number, m: number, d: number) => Date.UTC(y, m, d) / DAY_MS
    expect(days.find((d) => d.day === local(2026, 9, 30))).toMatchObject({ edits: 1 })
    expect(days.find((d) => d.day === local(2026, 10, 1))).toMatchObject({ edits: 1 })
    expect(days.filter((d) => d.edits > 0)).toHaveLength(2)
  })

  it('counts each note on its own, and a note with nothing as idle', () => {
    const strips = buildStrips(
      ['a', 'b'],
      [version('a', NOW, 50, 20), version('c', NOW, 900, 0)],
      NOW,
      UTC,
      new Map([['b', 7]]),
    )
    expect(strips['a']!.at(-1)).toMatchObject({ edits: 1, chars: 30, level: 1 })
    expect(strips['b']!.at(-1)).toMatchObject({ edits: 1, chars: 7, level: 1 })
    expect(Object.keys(strips)).toEqual(['a', 'b'])
  })
})

describe('activity strips on SQLite', () => {
  it('counts the versions of the notes asked for, without saving anything', async () => {
    const { storage, notes } = service()
    time = NOW - 3 * DAY_MS
    const a = await notes.create('A')
    await typeAndPause(notes, a, 'x'.repeat(120))
    time = NOW
    const b = await notes.create('B')
    await typeAndPause(notes, b, 'hello')
    await notes.setTitle(a, 'A2')
    await notes.flush()
    const before = (await storage.listRevisions(a)).length
    const strips = await notes.noteActivity([a], time, UTC)
    expect(Object.keys(strips)).toEqual([a])
    expect(strips[a]!.at(-4)).toMatchObject({ edits: 1, chars: 120, level: 2 })
    expect(strips[a]!.at(-1)).toMatchObject({ edits: 1, chars: 0, level: 1 })
    expect((await storage.listRevisions(a)).length).toBe(before)
  })

  it('counts typing not kept as a version yet, today, and once it is kept, the same', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    await typeAndPause(notes, id, 'one')
    await type(notes, id, 'one two three')
    expect((await strip(notes, id)).at(-1)).toEqual({ edits: 2, chars: 13 })
    expect((await storage.listRevisions(id)).filter((r) => r.kind === 'body')).toHaveLength(1)
    await advance(REVISION_PAUSE_MS + 1000)
    expect((await strip(notes, id)).at(-1)).toEqual({ edits: 2, chars: 13 })
  })

  it('never counts the text a note arrived with', async () => {
    const { notes } = service()
    const id = await notes.create('Imported')
    await notes.setBody(id, 'arrived with this')
    await notes.release(id)
    await notes.setBody(id, 'arrived with this!')
    await advance(REVISION_PAUSE_MS + 1000)
    expect((await strip(notes, id)).at(-1)).toEqual({ edits: 1, chars: 1 })
  })

  it('counts an old day by its net change once compaction thins it', async () => {
    const { storage, notes } = service()
    const sweeps = watchSweeps(storage)
    const day = today - 10
    time = day * DAY_MS + 9 * HOUR
    const id = await notes.create()
    for (const text of ['a'.repeat(100), 'a'.repeat(300), 'a'.repeat(50)]) {
      await typeAndPause(notes, id, text)
      time += HOUR
    }
    // Over a week on: the newest versions, which compaction always keeps.
    time = (day + 8) * DAY_MS + 9 * HOUR
    for (let i = 0; i < KEEP_NEWEST; i += 1) await typeAndPause(notes, id, 'b'.repeat(i + 1))
    time = NOW
    const onDay = async () => (await strip(notes, id))[day - (today - STRIP_DAYS + 1)]
    expect(await onDay()).toEqual({ edits: 3, chars: 100 + 200 + 250 })
    const done = sweeps.count
    await type(notes, await notes.create(), 'x')
    await notes.flush()
    await sweeps.until(done + 1)
    expect(await onDay()).toEqual({ edits: 1, chars: 50 })
  })

  it('forgets a purged note', async () => {
    const { notes } = service()
    const kept = await notes.create()
    await typeAndPause(notes, kept, 'kept')
    const gone = await notes.create()
    await typeAndPause(notes, gone, 'gone')
    await notes.trash(gone)
    await notes.purge(gone)
    const strips = await notes.noteActivity([kept, gone], time, UTC)
    expect(strips[kept]!.at(-1)!.edits).toBe(1)
    expect(strips[gone]!.every((d) => d.edits === 0)).toBe(true)
  })

  it('reads only the notes asked for, from covering indexes, never a Yjs state', () => {
    const storage = sqlite()
    const plan = (
      storage.db
        .prepare(`EXPLAIN QUERY PLAN ${ACTIVITY_SQL.noteRevisions}`)
        .all({ ids: '["a","b"]', since: 0 }) as { detail: string }[]
    )
      .map((p) => p.detail)
      .join('\n')
    expect(plan).toMatch(/SEARCH r USING COVERING INDEX revisions_history \(note_id=\? AND at>\?\)/)
    expect(plan).toMatch(
      /SEARCH p USING COVERING INDEX revisions_activity \(note_id=\? AND kind=\? AND at<\?\)/,
    )
    // The only scan is of the IDs asked for.
    expect(plan.replace(/SCAN json_each VIRTUAL TABLE[^\n]*/, '')).not.toMatch(/SCAN|TEMP B-TREE/)
  })

  it('runs the same statement as the Rust store', () => {
    const rust = readFileSync('src-tauri/src/storage/mod.rs', 'utf8')
    const statement = /const NOTE_ACTIVITY_SQL: &str =\s*"([^"]*)";/.exec(rust)?.[1] ?? ''
    const words = (sql: string) => sql.split(/\s+/).join(' ')
    expect(words(statement)).toBe(words(ACTIVITY_SQL.noteRevisions))
  })
})

describe('the UI tests’ memory adapter', () => {
  it('answers listNoteActivity like SQLite', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    const run = async (storage: StorageAdapter) => {
      const { notes } = service(storage)
      time = NOW - 20 * DAY_MS
      const a = await notes.create('A')
      await typeAndPause(notes, a, 'one')
      time = NOW - 5 * DAY_MS
      await typeAndPause(notes, a, 'one two three')
      await notes.setTitle(a, 'A2')
      const b = await notes.create('B')
      await notes.setBody(b, 'arrived')
      await notes.release(b)
      await notes.setBody(b, 'arrived!')
      await advance(REVISION_PAUSE_MS + 1000)
      const c = await notes.create('C')
      await typeAndPause(notes, c, 'not asked for')
      time = NOW
      await notes.flush()
      const rows = await storage.listNoteActivity([a, b], NOW - 10 * DAY_MS)
      const ids = [a, b, c]
      return rows.map((r) => JSON.stringify({ ...r, noteId: `#${ids.indexOf(r.noteId)}` })).sort()
    }
    const fromSqlite = await run(sqlite())
    const fromMemory = await run(memoryStorage)
    expect(fromSqlite).toHaveLength(3)
    expect(fromSqlite.join()).toContain('"length":13,"previous":3')
    expect(fromSqlite.join()).toContain('"length":8,"previous":7')
    expect(fromMemory).toEqual(fromSqlite)
  })
})

it('an unknown note has an idle strip', async () => {
  const { notes } = service()
  expect(await strip(notes, '0192a6f0-0000-7000-8000-000000000001')).toEqual(
    Array.from({ length: STRIP_DAYS }, () => idle),
  )
})
