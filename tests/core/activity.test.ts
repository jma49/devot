import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  activitySince,
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  DAY_MS,
  heatmapStart,
  KEEP_NEWEST,
  REVISION_PAUSE_MS,
  type ActivityData,
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
// A Wednesday noon; the injected clock, with timers faked to follow it.
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
  const storage = openSqliteAdapter(join(tempDir('devot-activity-'), 'db'))
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

const heatmap = (notes: NoteService) => notes.activity(time, UTC)
const dayOf = async (notes: NoteService, day: number) => {
  const found = (await heatmap(notes)).days.find((d) => d.day === day)
  if (!found) throw new Error(`no day ${day}`)
  const { created, edited, chars } = found
  return { created, edited, chars }
}

describe('activity on SQLite', () => {
  it('keeps typing as a version before counting it, once', async () => {
    const { storage, notes } = service()
    const id = await notes.create('Plan')
    expect(await dayOf(notes, today)).toEqual({ created: 1, edited: 0, chars: 0 })
    await type(notes, id, 'hello world')
    expect(await dayOf(notes, today)).toEqual({ created: 1, edited: 1, chars: 11 })
    const versions = async () =>
      (await storage.listRevisions(id)).filter((r) => r.kind === 'body').length
    expect(await versions()).toBe(1)
    // The pause that follows takes no second version of the same text.
    await advance(REVISION_PAUSE_MS + 1000)
    expect(await versions()).toBe(1)
    expect(await dayOf(notes, today)).toEqual({ created: 1, edited: 1, chars: 11 })
  })

  it('counts a title change as an edit, and a pin as none', async () => {
    const { notes } = service()
    time = NOW - 5 * DAY_MS
    const id = await notes.create('Old')
    time = NOW
    await notes.setPinned(id, true)
    await notes.flush()
    expect(await dayOf(notes, today)).toEqual({ created: 0, edited: 0, chars: 0 })
    await notes.setTitle(id, 'Renamed')
    await notes.flush()
    expect(await dayOf(notes, today)).toEqual({ created: 0, edited: 1, chars: 0 })
  })

  it('measures the first change in the window from the version before it', async () => {
    const { notes } = service()
    time = NOW - 400 * DAY_MS
    const id = await notes.create()
    await type(notes, id, 'a'.repeat(100))
    await advance(REVISION_PAUSE_MS + 1000)
    time = NOW - 2 * DAY_MS
    await type(notes, id, 'a'.repeat(130))
    await advance(REVISION_PAUSE_MS + 1000)
    time = NOW
    expect(await dayOf(notes, today - 2)).toEqual({ created: 0, edited: 1, chars: 30 })
    const { total } = await heatmap(notes)
    expect(total).toEqual({ created: 0, chars: 30, activeDays: 1 })
  })

  it('never counts notebook, status or pin changes, nor text a note arrived with', async () => {
    const { storage, notes } = service()
    time = NOW - 100 * DAY_MS
    const id = await notes.create('Imported')
    await notes.setBody(id, 'x'.repeat(5_000))
    await notes.release(id)
    time = NOW
    await notes.setPinned(id, true)
    await notes.setStatus(id, 'active')
    await notes.flush()
    expect(await dayOf(notes, today - 100)).toEqual({ created: 1, edited: 0, chars: 0 })
    expect(await dayOf(notes, today)).toEqual({ created: 0, edited: 0, chars: 0 })
    // The pin kept the text the note arrived with, as its baseline.
    const versions = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
    expect(versions.map((v) => [v.at, v.value])).toEqual([[NOW - 100 * DAY_MS, 'baseline']])
  })

  it('never counts text a note had before its history began, when it is edited later', async () => {
    const storage = sqlite()
    time = NOW - 100 * DAY_MS
    const first = service(storage).notes
    const id = await first.create('Imported')
    await first.setBody(id, 'x'.repeat(5_000))
    await first.release(id)
    time = NOW - 50 * DAY_MS
    const second = service(storage).notes
    await second.setPinned(id, true)
    await second.flush()
    time = NOW
    const third = service(storage).notes
    await third.setBody(id, 'x'.repeat(5_001))
    expect(await dayOf(third, today - 100)).toEqual({ created: 1, edited: 0, chars: 0 })
    expect(await dayOf(third, today - 50)).toEqual({ created: 0, edited: 0, chars: 0 })
    expect(await dayOf(third, today)).toEqual({ created: 0, edited: 1, chars: 1 })
    expect((await heatmap(third)).total).toEqual({ created: 1, chars: 1, activeDays: 2 })
  })

  it('keeps that text out after compaction thins the day it was edited', async () => {
    const { storage, notes } = service()
    const day = today - 20
    time = day * DAY_MS + 9 * HOUR
    const id = await notes.create('Imported')
    await notes.setBody(id, 'x'.repeat(5_000))
    await notes.release(id)
    time += HOUR
    await notes.setBody(id, 'x'.repeat(5_010))
    await advance(REVISION_PAUSE_MS + 1000)
    time = NOW
    await type(notes, await notes.create(), 'x')
    await notes.flush()
    expect((await storage.listRevisions(id)).filter((r) => r.kind === 'body')).toHaveLength(2)
    expect(await dayOf(notes, day)).toEqual({ created: 1, edited: 1, chars: 10 })
  })

  it('keeps typing as a version on quit, on the day it was typed', async () => {
    const storage = sqlite()
    time = NOW - 100 * DAY_MS
    const first = service(storage).notes
    const id = await first.create()
    await type(first, id, 'q'.repeat(500))
    await first.flush({ versions: true })
    vi.clearAllTimers()
    time = NOW - 10 * DAY_MS
    const second = service(storage).notes
    await second.setPinned(id, true)
    await second.flush()
    time = NOW
    const third = service(storage).notes
    expect(await dayOf(third, today - 100)).toEqual({ created: 1, edited: 1, chars: 500 })
    await third.setBody(id, 'q'.repeat(501))
    expect(await dayOf(third, today - 100)).toEqual({ created: 1, edited: 1, chars: 500 })
    expect(await dayOf(third, today - 10)).toEqual({ created: 0, edited: 0, chars: 0 })
    expect(await dayOf(third, today)).toEqual({ created: 0, edited: 1, chars: 1 })
  })

  it('dates typing a crash left out of a version by its save, never a later pin', async () => {
    const storage = sqlite()
    time = NOW - 100 * DAY_MS
    const first = service(storage).notes
    const id = await first.create()
    await type(first, id, 'c'.repeat(100))
    await advance(REVISION_PAUSE_MS + 1000)
    await type(first, id, 'c'.repeat(600))
    await first.flush()
    vi.clearAllTimers()
    time = NOW - 10 * DAY_MS
    const second = service(storage).notes
    await second.setPinned(id, true)
    await second.flush()
    time = NOW
    const third = service(storage).notes
    await third.setBody(id, 'c'.repeat(601))
    expect(await dayOf(third, today - 100)).toEqual({ created: 1, edited: 1, chars: 600 })
    expect(await dayOf(third, today - 10)).toEqual({ created: 0, edited: 0, chars: 0 })
    expect(await dayOf(third, today)).toEqual({ created: 0, edited: 1, chars: 1 })
  })

  it('keeps notes in the Trash and forgets purged ones', async () => {
    const { notes } = service()
    const kept = await notes.create()
    await type(notes, kept, 'kept text')
    const gone = await notes.create()
    await type(notes, gone, 'purged text')
    await notes.trash(kept)
    await notes.trash(gone)
    await notes.purge(gone)
    expect(await dayOf(notes, today)).toEqual({ created: 1, edited: 1, chars: 9 })
  })

  it('counts the net change of an old day once compaction thins it', async () => {
    const { storage, notes } = service()
    const sweeps = watchSweeps(storage)
    const day = today - 20
    time = day * DAY_MS + 9 * HOUR
    const id = await notes.create()
    for (const text of ['a'.repeat(100), 'a'.repeat(300), 'a'.repeat(50)]) {
      await type(notes, id, text)
      await advance(REVISION_PAUSE_MS + 1000)
      time += HOUR
    }
    // Later writing, over a week on: the newest versions, which compaction
    // always keeps, and from which it counts the old day's age.
    time = (day + 10) * DAY_MS + 9 * HOUR
    for (let i = 0; i < KEEP_NEWEST; i += 1) {
      await type(notes, id, 'b'.repeat(i + 1))
      await advance(REVISION_PAUSE_MS + 1000)
    }
    time = NOW
    expect(await dayOf(notes, day)).toEqual({ created: 1, edited: 1, chars: 100 + 200 + 250 })
    const done = sweeps.count
    await type(notes, await notes.create(), 'x')
    await notes.flush()
    await sweeps.until(done + 1)
    const onDay = (await storage.listRevisions(id)).filter(
      (r) => r.kind === 'body' && Math.floor(r.at / DAY_MS) === day,
    )
    expect(onDay).toHaveLength(1)
    expect(await dayOf(notes, day)).toEqual({ created: 1, edited: 1, chars: 50 })
  })

  it('reads only the window, from covering indexes, never a Yjs state', () => {
    const storage = sqlite()
    const plan = (sql: string) =>
      (storage.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ since: 0 }) as { detail: string }[])
        .map((p) => p.detail)
        .join('\n')
    expect(plan(ACTIVITY_SQL.notes)).toMatch(
      /^SEARCH notes USING COVERING INDEX notes_created \(created_at>\?\)$/,
    )
    const revisions = plan(ACTIVITY_SQL.revisions)
    expect(revisions).toMatch(/SEARCH r USING COVERING INDEX revisions_by_time \(at>\?\)/)
    expect(revisions).toMatch(
      /SEARCH p USING COVERING INDEX revisions_activity \(note_id=\? AND kind=\? AND at<\?\)/,
    )
    expect(revisions).not.toMatch(/SCAN|TEMP B-TREE/)
  })

  it('runs the same statements as the Rust store', () => {
    const rust = readFileSync('src-tauri/src/storage/mod.rs', 'utf8')
    const statement = (name: string) =>
      new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(rust)?.[1] ?? ''
    const words = (sql: string) => sql.split(/\s+/).join(' ')
    expect(words(statement('ACTIVITY_NOTES_SQL'))).toBe(words(ACTIVITY_SQL.notes))
    expect(words(statement('ACTIVITY_REVISIONS_SQL'))).toBe(words(ACTIVITY_SQL.revisions))
  })
})

describe('the UI tests’ memory adapter', () => {
  it('answers listActivity like SQLite', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    const run = async (storage: StorageAdapter) => {
      const { notes } = service(storage)
      time = NOW - 30 * DAY_MS
      const a = await notes.create('A')
      await type(notes, a, 'one')
      await advance(REVISION_PAUSE_MS + 1000)
      time = NOW - 20 * DAY_MS
      await type(notes, a, 'one two three')
      await advance(REVISION_PAUSE_MS + 1000)
      await notes.setTitle(a, 'A2')
      time = NOW - 3 * DAY_MS
      // Arrives with its text, then is edited: its baseline is left out.
      const e = await notes.create('E')
      await notes.setBody(e, 'arrived')
      await notes.release(e)
      await notes.setBody(e, 'arrived!')
      await advance(REVISION_PAUSE_MS + 1000)
      const b = await notes.create('B')
      await type(notes, b, 'unversioned é\u{1f600}')
      await notes.flush()
      const c = await notes.create('C')
      await type(notes, c, 'trashed')
      await notes.trash(c)
      const d = await notes.create('D')
      await notes.trash(d)
      await notes.purge(d)
      time = NOW
      await notes.flush()
      const data = await storage.listActivity(activitySince(heatmapStart(today)))
      // IDs differ per run; compare by order of creation.
      const ids = [a, b, c, d, e]
      const named = (id: string) => `#${ids.indexOf(id)}`
      const sorted = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort()
      return {
        notes: sorted(data.notes.map((n) => ({ ...n, id: named(n.id) }))),
        revisions: sorted(data.revisions.map((r) => ({ ...r, noteId: named(r.noteId) }))),
      } satisfies Record<keyof ActivityData, string[]>
    }
    const fromSqlite = await run(sqlite())
    const fromMemory = await run(memoryStorage)
    expect(fromSqlite.notes).toHaveLength(4)
    expect(fromSqlite.revisions).toHaveLength(5)
    expect(fromSqlite.revisions.join()).toContain('"length":13,"previous":3')
    expect(fromSqlite.revisions.join()).toContain('"length":8,"previous":7')
    expect(fromMemory).toEqual(fromSqlite)
  })

  it('leaves out what came before `since`', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    for (const storage of [sqlite(), memoryStorage]) {
      const { notes } = service(storage)
      time = NOW - 10 * DAY_MS
      const id = await notes.create()
      await type(notes, id, 'early')
      await advance(REVISION_PAUSE_MS + 1000)
      time = NOW
      expect(await storage.listActivity(NOW - DAY_MS)).toEqual({ notes: [], revisions: [] })
      expect((await storage.listActivity(NOW - 11 * DAY_MS)).notes).toHaveLength(1)
    }
  })
})
