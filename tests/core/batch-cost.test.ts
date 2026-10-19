// Batch change cost per note: one notebook check per batch; a note not in memory is written back
// as stored (no Yjs document); the search index is untouched unless title or Markdown change.
// Its history stays what writing the note in memory would give.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyBatch,
  BASELINE,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  formatHlc,
  parseSearch,
  resolveSearch,
  type NoteRecord,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function servicesOn(path: string) {
  const sqlite = openSqliteAdapter(path)
  open.push(sqlite)
  const calls = new Map<string, number>()
  let gate: Promise<void> | undefined
  const storage = new Proxy(sqlite, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown
      if (typeof value !== 'function' || typeof name !== 'string') return value
      return async (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1)
        const wait = name === 'putNote' ? gate : undefined
        if (wait) {
          gate = undefined
          await wait
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as StorageAdapter
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  const books = createBookService({ storage, clock, newId })
  return {
    sqlite,
    notes,
    books,
    services: { notes, tags },
    /** The next note write waits until the function returned is called. */
    holdNextWrite() {
      let release = () => {}
      gate = new Promise((resolve) => (release = resolve))
      return release
    },
    /**
     * Storage calls made since the last time, by name; compaction sweeps (at most hourly) left out.
     */
    calls() {
      for (const sweep of ['lastCompaction', 'listCompactable', 'compactRevisions']) {
        calls.delete(sweep)
      }
      const made = Object.fromEntries(calls)
      calls.clear()
      return made
    },
  }
}

async function library(path: string, count: number) {
  const { notes } = servicesOn(path)
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = await notes.create(`Note ${i}`)
    await notes.setBody(id, `# Note ${i}\n\nSome text in note ${i}.`)
    await notes.release(id)
    ids.push(id)
  }
  return ids
}

describe('a batch change', () => {
  it('moves 100 notes with the notebook checked once and five storage calls a note', async () => {
    const path = join(tempDir('devot-batch-cost-'), 'devot.sqlite')
    const ids = await library(path, 100)
    const s = servicesOn(path)
    const book = await s.books.create('Work', null)
    const before = new Map(
      await Promise.all(ids.map(async (id) => [id, (await s.sqlite.getNote(id))!] as const)),
    )
    s.calls()

    const result = await applyBatch(s.services, ids, { kind: 'book', bookId: book })
    await s.notes.flush()
    expect(result).toEqual({ changed: ids, failed: [] })
    // Per note: the note read, its history checked, a baseline kept (these
    // notes have none yet), the note written and its event recorded.
    expect(s.calls()).toEqual({
      listBooks: 1,
      getNote: 100,
      listRevisions: 100,
      putRevision: 200,
      putNote: 100,
    })
    for (const id of ids) {
      const stored = (await s.sqlite.getNote(id))!
      const was = before.get(id)!
      expect(stored.bookId).toBe(book)
      expect(stored.bodyMd).toBe(was.bodyMd)
      expect(Buffer.from(stored.ydoc).equals(Buffer.from(was.ydoc))).toBe(true)
      expect(stored.updatedAt).toBeGreaterThanOrEqual(was.updatedAt)
    }
  })

  it('keeps the history writing the note in memory would keep', async () => {
    const path = join(tempDir('devot-batch-cost-'), 'devot.sqlite')
    const [cold, warm] = await library(path, 2)
    const s = servicesOn(path)
    const book = await s.books.create('Work', null)
    await s.notes.open(warm!)
    await applyBatch(s.services, [cold!, warm!], { kind: 'book', bookId: book })
    await applyBatch(s.services, [cold!, warm!], { kind: 'status', status: 'active' })
    await s.notes.flush()
    const history = async (id: string) =>
      (await s.sqlite.listRevisions(id)).map(({ kind, value, length }) => ({ kind, value, length }))
    const expected = [
      { kind: 'status', value: 'active', length: null },
      { kind: 'book', value: book, length: null },
      { kind: 'body', value: BASELINE, length: '# Note 0\n\nSome text in note 0.'.length },
    ]
    expect(await history(cold!)).toEqual(expected)
    expect(await history(warm!)).toEqual(expected)
    // The baseline is the body as it was saved, dated by that save.
    const [baseline] = (await s.sqlite.listRevisions(cold!)).filter((r) => r.kind === 'body')
    expect(baseline?.at).toBeLessThan((await s.sqlite.getNote(cold!))!.updatedAt + 1)
  })

  it('refuses a notebook that is not live before any note changes', async () => {
    const path = join(tempDir('devot-batch-cost-'), 'devot.sqlite')
    const ids = await library(path, 3)
    const s = servicesOn(path)
    await expect(applyBatch(s.services, ids, { kind: 'book', bookId: 'missing' })).rejects.toThrow(
      'E_BOOK_NOT_FOUND',
    )
    expect((await s.sqlite.getNote(ids[0]!))?.bookId).toBeNull()
  })

  it('lets a note opened during its write show the change', async () => {
    const path = join(tempDir('devot-batch-cost-'), 'devot.sqlite')
    const [id] = await library(path, 1)
    const s = servicesOn(path)
    const book = await s.books.create('Work', null)
    const release = s.holdNextWrite()
    const moving = s.notes.writeMeta(id!, { bookId: book })
    const opening = s.notes.open(id!)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([moving, opening])
    expect((await s.notes.read(id!)).bookId).toBe(book)
    await s.notes.setStatus(id!, 'active')
    await s.notes.flush()
    expect(await s.sqlite.getNote(id!)).toMatchObject({ bookId: book, status: 'active' })
  })
})

describe('the search index', () => {
  /** Rows the last statements changed, those of triggers (the index) included. */
  const changes = (sqlite: SqliteAdapter) =>
    (sqlite.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

  const record = (fields: Partial<NoteRecord>): NoteRecord => ({
    id: 'note',
    title: 'Launch plan',
    titleHlc: formatHlc({ wall: 1, counter: 0, node: 'test' }),
    bodyMd: 'The relay goes first.',
    ydoc: new Uint8Array([0]),
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
    ...fields,
  })
  const hlc = (wall: number) => formatHlc({ wall, counter: 0, node: 'test' })

  it('is rewritten only when a write changes the title or the Markdown, and stays exact', async () => {
    const sqlite = openSqliteAdapter(join(tempDir('devot-fts-'), 'devot.sqlite'))
    open.push(sqlite)
    const found = async (query: string) =>
      (
        await sqlite.searchNotes(resolveSearch(parseSearch(query), { books: [], tags: [] })!, 10)
      ).map((n) => n.id)
    await sqlite.putNote(record({}))
    // Each write changes the note's row; a text change also takes the old text out of the index
    // and puts the new in (index tables), each based on the body version the one before left.
    let bodyVersion = 1
    const cost = async (fields: Partial<NoteRecord>) => {
      const before = changes(sqlite)
      await sqlite.putNote(record({ ...fields, bodyVersion }))
      bodyVersion += 1
      return changes(sqlite) - before
    }
    expect(await cost({ status: 'active', statusHlc: hlc(2), updatedAt: 2 })).toBe(1)
    expect(await cost({ pinned: true, pinnedHlc: hlc(3), updatedAt: 3 })).toBe(1)
    expect(await cost({ deletedAt: 4, deletedHlc: hlc(4) })).toBe(1)
    expect(await cost({ deletedAt: null, deletedHlc: hlc(5) })).toBe(1)
    expect(await found('relay')).toEqual(['note'])
    expect(await found('launch')).toEqual(['note'])

    expect(await cost({ title: 'Launch day', titleHlc: hlc(6), updatedAt: 6 })).toBeGreaterThan(1)
    expect(await found('plan')).toEqual([])
    expect(await found('title:"launch day"')).toEqual(['note'])
    expect(
      await cost({ title: 'Launch day', titleHlc: hlc(6), bodyMd: 'Snapshot first.' }),
    ).toBeGreaterThan(1)
    expect(await found('relay')).toEqual([])
    expect(await found('snapshot')).toEqual(['note'])
    sqlite.db.exec(`INSERT INTO notes_fts (notes_fts, rank) VALUES ('integrity-check', 1)`)
  })
})
