// Saving notes: a failed save keeps its changes, retries them and reports
// the note; writes of one note go one at a time, and flush waits for them.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  type NoteRecord,
  type NoteService,
  type SaveProblem,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
const services: { notes: NoteService; allowWrites: () => void }[] = []
afterEach(async () => {
  // Nothing left failing: no retry outlives its test.
  for (const s of services.splice(0)) {
    s.allowWrites()
    await s.notes.flush().catch(() => {})
  }
  open.splice(0).forEach((a) => a.close())
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A note service on a fresh SQLite file whose note writes the test controls:
 * they fail with E_TEST_WRITE while `failWrites` says so, and `holdNextWrite`
 * keeps the next one waiting. Retries wait `retryDelayMs` (long by default,
 * so only the test's own saves write). The service's reports are kept, and
 * also passed to `listener`.
 */
function setup({
  retryDelayMs = 60_000,
  listener,
}: { retryDelayMs?: number; listener?: (problems: SaveProblem[]) => void } = {}) {
  const sqlite = openSqliteAdapter(join(tempDir('devot-saves-'), 'devot.sqlite'))
  open.push(sqlite)
  const writes: NoteRecord[] = []
  let refuse: (record: NoteRecord) => boolean = () => false
  let gate: Promise<void> | undefined
  const storage: StorageAdapter = Object.assign(Object.create(sqlite) as SqliteAdapter, {
    async putNote(record: NoteRecord) {
      writes.push(record)
      const wait = gate
      gate = undefined
      if (wait) await wait
      if (refuse(record)) throw new Error('E_TEST_WRITE')
      await sqlite.putNote(record)
    },
  })
  const reports: SaveProblem[][] = []
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
    retryDelayMs,
    onSaveProblems: (problems) => {
      reports.push(problems)
      listener?.(problems)
    },
  })
  const allowWrites = () => (refuse = () => false)
  services.push({ notes, allowWrites })
  return {
    notes,
    sqlite,
    writes,
    reports,
    problems: () => reports.at(-1) ?? [],
    stored: (id: string) => sqlite.getNote(id, { trashed: true }),
    failWrites(when: (record: NoteRecord) => boolean = () => true) {
      refuse = when
    },
    allowWrites,
    holdNextWrite() {
      let release = () => {}
      gate = new Promise((resolve) => (release = resolve))
      return release
    },
  }
}

describe('a save that fails', () => {
  it('keeps its changes: the quit flush writes them', async () => {
    const s = setup()
    const id = await s.notes.create()
    s.failWrites()
    await s.notes.setBody(id, 'typed, then the autosave failed')
    await vi.waitFor(() => expect(s.problems()).toEqual([{ id, code: 'E_TEST_WRITE' }]))
    s.allowWrites()
    await s.notes.flush({ versions: true })
    expect((await s.stored(id))?.bodyMd).toBe('typed, then the autosave failed')
    expect(s.problems()).toEqual([])
  })

  it('is tried again on its own until it saves, and reported until then', async () => {
    const s = setup({ retryDelayMs: 5 })
    const id = await s.notes.create()
    s.failWrites()
    await s.notes.setBody(id, 'kept')
    await vi.waitFor(() => expect(s.problems()).toEqual([{ id, code: 'E_TEST_WRITE' }]))
    const tried = s.writes.length
    await vi.waitFor(() => expect(s.writes.length).toBeGreaterThan(tried), { timeout: 5000 })
    expect(s.reports.filter((r) => r.length > 0)).toHaveLength(1)
    s.allowWrites()
    await vi.waitFor(() => expect(s.problems()).toEqual([]), { timeout: 5000 })
    expect((await s.stored(id))?.bodyMd).toBe('kept')
  })

  it('makes flush reject with the note ID, while the other notes are saved', async () => {
    const s = setup()
    const bad = await s.notes.create('Bad')
    const good = await s.notes.create('Good')
    s.failWrites((record) => record.id === bad)
    await s.notes.setBody(bad, 'not saved yet')
    await s.notes.setBody(good, 'saved')
    const error = await s.notes.flush({ versions: true }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(error?.message).toBe(`E_NOTE_SAVE_FAILED ${bad}`)
    expect((await s.stored(good))?.bodyMd).toBe('saved')
    expect(s.problems()).toEqual([{ id: bad, code: 'E_TEST_WRITE' }])
    const versions = await s.sqlite.listRevisions(bad)
    expect(versions.some((v) => v.kind === 'body' && v.length === 'not saved yet'.length)).toBe(
      true,
    )
    s.allowWrites()
    await s.notes.flush()
    expect((await s.stored(bad))?.bodyMd).toBe('not saved yet')
  })

  it('does not stop searching, history or activity', async () => {
    const s = setup()
    const bad = await s.notes.create('Unsaved')
    const ok = await s.notes.create('Saved')
    await s.notes.setBody(ok, 'needle')
    await s.notes.setTitle(ok, 'Saved, renamed')
    await s.notes.flush()
    s.failWrites((record) => record.id === bad)
    await s.notes.setBody(bad, 'needle too')
    expect((await s.notes.search('needle')).map((n) => n.id)).toEqual([ok])
    expect((await s.notes.history(ok)).map((e) => e.kind)).toEqual(['title'])
    expect((await s.notes.activity(Date.now())).total.created).toBe(2)
  })

  it('of a metadata change takes back only that change; a note not in memory is let go', async () => {
    const s = setup({ retryDelayMs: 5 })
    const id = await s.notes.create('Note')
    await s.notes.open(id)
    s.failWrites()
    const release = s.holdNextWrite()
    const pinning = s.notes.writeMeta(id, { pinned: true })
    await vi.waitFor(() => expect(s.writes).toHaveLength(2))
    await s.notes.setStatus(id, 'active')
    release()
    await expect(pinning).rejects.toThrow('E_TEST_WRITE')
    s.allowWrites()
    await s.notes.flush()
    expect(await s.stored(id)).toMatchObject({ status: 'active', pinned: false })
    expect(s.problems()).toEqual([])

    // Not in memory: nothing else is pending, so nothing is retried or reported.
    await s.notes.release(id)
    const reported = s.reports.length
    s.failWrites()
    await expect(s.notes.writeMeta(id, { pinned: true })).rejects.toThrow('E_TEST_WRITE')
    const tried = s.writes.length
    await sleep(50)
    expect(s.writes).toHaveLength(tried)
    expect(s.reports).toHaveLength(reported)
  })

  it('of a trash leaves the note out of the Trash, also for later saves', async () => {
    const s = setup()
    const id = await s.notes.create('Kept')
    await s.notes.setBody(id, 'body')
    await s.notes.flush()
    s.failWrites((record) => record.deletedAt !== null)
    await expect(s.notes.trash(id)).rejects.toThrow('E_TEST_WRITE')
    s.allowWrites()
    await s.notes.setBody(id, 'body, edited after')
    await s.notes.flush()
    expect(await s.stored(id)).toMatchObject({ deletedAt: null, bodyMd: 'body, edited after' })
  })

  it('is kept apart from a listener that throws', async () => {
    const s = setup({
      listener: () => {
        throw new Error('E_TEST_LISTENER')
      },
    })
    const id = await s.notes.create()
    s.failWrites()
    await s.notes.setBody(id, 'kept')
    await expect(s.notes.flush()).rejects.toThrow(`E_NOTE_SAVE_FAILED ${id}`)
    s.allowWrites()
    await s.notes.flush()
    expect((await s.stored(id))?.bodyMd).toBe('kept')
    // Saved, so no longer reported, and nothing is left to try again.
    expect(s.problems()).toEqual([])
    await s.notes.setBody(id, 'kept, and more')
    await s.notes.flush()
    expect((await s.stored(id))?.bodyMd).toBe('kept, and more')
  })

  it('of a release rejects and leaves nothing to retry (the caller undoes the note)', async () => {
    const s = setup({ retryDelayMs: 5 })
    const id = await s.notes.create()
    s.failWrites()
    await s.notes.setBody(id, 'imported text')
    await expect(s.notes.release(id)).rejects.toThrow('E_TEST_WRITE')
    const tried = s.writes.length
    await sleep(50)
    expect(s.writes).toHaveLength(tried)
    expect(s.reports.flat()).toEqual([])
  })
})

describe('saves of one note', () => {
  it('make flush wait for the one under way', async () => {
    const s = setup()
    const id = await s.notes.create()
    const release = s.holdNextWrite()
    await s.notes.setBody(id, 'last words before quitting')
    // The autosave has started and waits.
    await vi.waitFor(() => expect(s.writes).toHaveLength(2))
    let flushed = false
    const flushing = s.notes.flush({ versions: true }).then(() => {
      flushed = true
    })
    await sleep(20)
    expect(flushed).toBe(false)
    release()
    await flushing
    expect((await s.stored(id))?.bodyMd).toBe('last words before quitting')
  })

  it('go one at a time, so the newest text is written last', async () => {
    const s = setup()
    const id = await s.notes.create()
    const release = s.holdNextWrite()
    await s.notes.setBody(id, 'older')
    await vi.waitFor(() => expect(s.writes).toHaveLength(2))
    await s.notes.setBody(id, 'newer')
    const searching = s.notes.search('newer')
    await sleep(20)
    // The second write waits for the first.
    expect(s.writes).toHaveLength(2)
    release()
    expect((await searching).map((n) => n.id)).toEqual([id])
    expect(s.writes.map((w) => w.bodyMd)).toEqual(['', 'older', 'newer'])
    expect((await s.stored(id))?.bodyMd).toBe('newer')
  })
})
