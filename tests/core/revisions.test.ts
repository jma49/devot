import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  KEEP_NEWEST,
  REVISION_EVERY_MS,
  REVISION_PAUSE_MS,
  type NoteService,
  type RevisionRecord,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { watchSweeps } from '../support/sweeps'
import { tempDir } from '../support/temp-dirs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const open: SqliteAdapter[] = []
// The injected clock; timers are faked so they follow it.
let time = Date.UTC(2026, 9, 10, 12)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  time = Date.UTC(2026, 9, 10, 12)
})
afterEach(() => {
  vi.useRealTimers()
  open.splice(0).forEach((a) => a.close())
})

/** Moves the clock and runs the timers that fall due on the way. */
async function advance(ms: number) {
  const step = 1000
  for (let left = ms; left > 0; left -= step) {
    time += Math.min(step, left)
    await vi.advanceTimersByTimeAsync(Math.min(step, left))
  }
}

function freshPath() {
  return join(tempDir('devot-revisions-'), 'devot.sqlite')
}

function service(path = freshPath()) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, now: () => time, saveDelayMs: 300 })
  return { path, storage, notes, books: createBookService({ storage, clock, newId }) }
}

/**
 * An editor replica wired to the service the way the UI wires its Yjs
 * document. Undo is the editor's own (CodeMirror history), tested in
 * src/renderer/src/editor/undo.test.ts and tests/ui/history.spec.ts.
 */
async function editorFor(notes: NoteService, id: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state, 'remote')
  const pending: Promise<void>[] = []
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote' && origin !== 'restore') pending.push(notes.applyUpdate(id, update))
  })
  const text = doc.getText(BODY)
  return {
    doc,
    text,
    /** Replaces the whole text with one edit. */
    async type(next: string) {
      doc.transact(() => {
        text.delete(0, text.length)
        text.insert(0, next)
      })
      await Promise.all(pending)
    },
  }
}

const bodies = async (storage: SqliteAdapter, id: string) =>
  (await storage.listRevisions(id)).filter((r) => r.kind === 'body')

const textOf = (revision: RevisionRecord | null) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, revision!.ydoc!)
  return doc.getText(BODY).toString()
}

describe('taking versions', () => {
  it('takes a version once editing pauses', async () => {
    const { storage, notes } = service()
    const id = await notes.create('Plan')
    const editor = await editorFor(notes, id)
    await editor.type('first draft')
    await advance(REVISION_PAUSE_MS - 1000)
    expect(await bodies(storage, id)).toEqual([])

    await advance(1000)
    const [version] = await bodies(storage, id)
    expect(version).toMatchObject({ kind: 'body', length: 11, at: time })
    expect(textOf(await storage.getRevision(version!.id))).toBe('first draft')
  })

  it('takes a version at least every ten minutes of continuous editing', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    const start = time
    let text = ''
    for (let i = 0; i < 50; i += 1) {
      text += `${i} `
      await editor.type(text)
      await advance(30_000)
    }
    // 25 minutes of typing: versions at the 10 and 20 minute marks.
    const taken = (await bodies(storage, id)).map((r) => r.at - start).sort((a, b) => a - b)
    expect(taken).toEqual([REVISION_EVERY_MS, 2 * REVISION_EVERY_MS])

    await advance(REVISION_PAUSE_MS)
    expect(await bodies(storage, id)).toHaveLength(3)
  })

  it('does not take a version when the text ends up as it was', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    await editor.type('same')
    await advance(REVISION_PAUSE_MS)
    await editor.type('changed')
    await editor.type('same')
    await advance(REVISION_PAUSE_MS)
    expect(await bodies(storage, id)).toHaveLength(1)
  })

  it('keeps the text from before the first edit when no version holds it', async () => {
    // Notes made by import or devot-mcp, or before history existed, have
    // no version yet: their first edit records the text it replaces.
    const first = service()
    const id = await first.notes.create('Imported')
    await first.notes.setBody(id, 'from a file')
    await first.notes.release(id)
    expect(await bodies(first.storage, id)).toEqual([])
    const savedAt = (await first.storage.getNote(id))!.updatedAt

    await advance(HOUR)
    const second = service(first.path)
    const editor = await editorFor(second.notes, id)
    await editor.type('edited')
    await second.notes.flush()
    const [baseline] = await bodies(second.storage, id)
    expect(baseline).toMatchObject({ at: savedAt, length: 11 })
    expect(textOf(await second.storage.getRevision(baseline!.id))).toBe('from a file')

    await advance(REVISION_PAUSE_MS)
    expect((await bodies(second.storage, id)).map((r) => r.length)).toEqual([6, 11])
  })

  it('does not repeat a version the history already has', async () => {
    const first = service()
    const id = await first.notes.create()
    const editor = await editorFor(first.notes, id)
    await editor.type('kept')
    await advance(REVISION_PAUSE_MS)
    expect(await bodies(first.storage, id)).toHaveLength(1)

    const second = service(first.path)
    await (await editorFor(second.notes, id)).type('kept, then edited')
    await second.notes.flush()
    expect(await bodies(second.storage, id)).toHaveLength(1)
  })

  it('takes no version of an empty new note', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    await (await editorFor(notes, id)).type('x')
    await notes.flush()
    expect(await bodies(storage, id)).toEqual([])
  })

  it('takes the last version before a note goes to the Trash, and keeps them there', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    await (await editorFor(notes, id)).type('last words')
    await notes.trash(id)
    expect((await bodies(storage, id)).map((r) => r.length)).toEqual([10])
    await advance(REVISION_PAUSE_MS)
    await notes.restore(id)
    expect(await bodies(storage, id)).toHaveLength(1)
  })

  it('deletes every revision when the note is deleted permanently', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    await (await editorFor(notes, id)).type('soon gone')
    await advance(REVISION_PAUSE_MS)
    await notes.setPinned(id, true)
    await notes.flush()
    expect(await storage.listRevisions(id)).toHaveLength(2)
    await notes.trash(id)
    await notes.purge(id)
    expect(await storage.listRevisions(id)).toEqual([])
    // A write that arrives late does not bring any back.
    await storage.putRevision({
      id: '0192a6f0-0000-7000-8000-000000000001',
      noteId: id,
      kind: 'pinned',
      at: time,
      ydoc: null,
      length: null,
      value: '0',
    })
    expect(await storage.listRevisions(id)).toEqual([])
  })
})

describe('compaction', () => {
  /** Plain versions of a note at these times, with the state of `ydoc`. */
  const versionsAt = (noteId: string, times: number[], ydoc: Uint8Array, first: number) =>
    times.map((at, i): RevisionRecord => ({
      id: `0192a6f0-0000-7000-8000-${String(first + i).padStart(12, '0')}`,
      noteId,
      kind: 'body',
      at,
      ydoc,
      length: 4,
      value: null,
    }))

  it('sweeps after a save, at most once an hour', async () => {
    const start = time
    const { storage, notes } = service()
    const sweeps = watchSweeps(storage)
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    await editor.type('seed')
    await advance(REVISION_PAUSE_MS)
    await sweeps.until(1)
    const [seed] = await bodies(storage, id)
    const ydoc = (await storage.getRevision(seed!.id))!.ydoc!
    // Two versions in one hour (the start is on the hour), just under a day
    // old, and the newest versions, which are always kept, since.
    const olds = versionsAt(
      id,
      [10, 40].map((minute) => start - DAY + minute * MINUTE),
      ydoc,
      1,
    )
    const recent = Array.from({ length: KEEP_NEWEST }, (_, i) => start + (i + 1) * 1000)
    for (const r of [...olds, ...versionsAt(id, recent, ydoc, 100)]) await storage.putRevision(r)
    const ids = async () => new Set((await bodies(storage, id)).map((r) => r.id))

    // Both are a day old after this, but the last sweep ran under an hour ago.
    await advance(59 * MINUTE - REVISION_PAUSE_MS)
    await editor.type('seed, more')
    await notes.flush()
    expect(sweeps.count).toBe(1)
    const before = await ids()
    expect(before.has(olds[0]!.id)).toBe(true)

    // The next sweep drops the older of the two.
    await advance(2 * MINUTE)
    await editor.type('seed, more, again')
    await notes.flush()
    await sweeps.until(2)
    const left = await ids()
    expect(left.has(olds[0]!.id)).toBe(false)
    expect(left.has(olds[1]!.id)).toBe(true)
    // With the version taken in the pause before the last edit.
    expect(left.size).toBe(before.size)
  })

  it('thins notes that take no new version, after a save of any note', async () => {
    // Local noon, so the versions below fall on one local day in any time zone.
    time = new Date(2026, 9, 10, 12).getTime()
    const { storage, notes } = service()
    const sweeps = watchSweeps(storage)
    const quiet = await notes.create()
    const doc = new Y.Doc()
    doc.getText(BODY).insert(0, 'kept')
    const ydoc = Y.encodeStateAsUpdate(doc)
    let n = 0
    const old = (at: number): RevisionRecord => versionsAt(quiet, [at], ydoc, (n += 1))[0]!
    // A day of editing a month ago, an hour of it three days ago, two hours
    // just under a week ago and one hour just under a day ago; and the
    // newest versions, which are always kept, in the last hour.
    const month = Array.from({ length: 6 }, (_, i) => old(time - 30 * DAY - i * 10 * MINUTE))
    const days = Array.from({ length: 3 }, (_, i) => old(time - 3 * DAY + i * MINUTE))
    const week = [old(time - 7 * DAY + 90 * MINUTE), old(time - 7 * DAY + 150 * MINUTE)]
    const hour = Math.floor((time - 23 * HOUR) / HOUR) * HOUR
    const day = [old(hour + 5 * MINUTE), old(hour + 50 * MINUTE)]
    const newest = Array.from({ length: KEEP_NEWEST }, (_, i) => old(time - (i + 1) * MINUTE))
    for (const r of [...month, ...days, ...week, ...day, ...newest]) await storage.putRevision(r)
    const ids = async () => new Set((await bodies(storage, quiet)).map((r) => r.id))
    const kept = (...revisions: RevisionRecord[]) =>
      new Set([...revisions, ...newest].map((r) => r.id))

    // The quiet note is never edited; a save of another note starts the sweep.
    const other = await notes.create()
    const editor = await editorFor(notes, other)
    await editor.type('busy')
    await notes.flush()
    await sweeps.until(1)
    expect(await ids()).toEqual(kept(month[0]!, days[2]!, ...week, ...day))

    // Hours later, nothing more: ages count from the note's newest version
    // (see revisionsToDrop), and the note took none since.
    await advance(3 * HOUR)
    await editor.type('busy, still')
    await notes.flush()
    await sweeps.until(2)
    expect(await ids()).toEqual(kept(month[0]!, days[2]!, ...week, ...day))

    // A version taken now, and a day on: the versions that crossed a day or
    // a week of age by it are thinned too.
    const latest = old(time)
    await storage.putRevision(latest)
    time += 25 * HOUR
    await editor.type('busy, a day on')
    await notes.flush()
    await sweeps.until(3)
    expect(await ids()).toEqual(kept(latest, month[0]!, days[2]!, week[1]!, day[1]!))
  })
})

describe('restoring a version', () => {
  async function twoVersions() {
    const setup = service()
    const id = await setup.notes.create()
    const editor = await editorFor(setup.notes, id)
    await editor.type('# Plan\n\nfirst draft\n')
    await advance(REVISION_PAUSE_MS)
    await editor.type('# Plan\n\nsecond draft, much longer\n')
    await advance(REVISION_PAUSE_MS)
    const [newer, older] = await bodies(setup.storage, id)
    return { ...setup, id, editor, older: older!, newer: newer! }
  }

  it('applies the old text to the note as an edit and saves it', async () => {
    const { storage, notes, id, editor, older } = await twoVersions()
    const kept = await storage.getRevision(older.id)
    const before = Y.encodeStateVector(editor.doc)

    // One update, applied in one transaction: the editor makes it one undo step.
    const update = await notes.restoreRevision(id, older.id)
    let transactions = 0
    editor.doc.on('afterTransaction', () => (transactions += 1))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(transactions).toBe(1)
    expect(editor.text.toString()).toBe('# Plan\n\nfirst draft\n')
    await notes.flush()
    expect((await storage.getNote(id))!.bodyMd).toBe('# Plan\n\nfirst draft\n')

    // A forward edit: every earlier operation is still in the document, and
    // the version itself was never written back.
    const after = Y.decodeStateVector(Y.encodeStateVector(editor.doc))
    for (const [client, clock] of Y.decodeStateVector(before)) {
      expect(after.get(client)).toBeGreaterThanOrEqual(clock)
    }
    expect(await storage.getRevision(older.id)).toEqual(kept)
  })

  it('keeps unsaved edits as a version before replacing them', async () => {
    const { storage, notes, id, editor, older } = await twoVersions()
    await editor.type('typed just now')
    await notes.restoreRevision(id, older.id)
    const [latest] = await bodies(storage, id)
    expect(textOf(await storage.getRevision(latest!.id))).toBe('typed just now')
  })

  it('refuses a revision of another note or a metadata event', async () => {
    const { notes, id, older } = await twoVersions()
    const other = await notes.create()
    await expect(notes.restoreRevision(other, older.id)).rejects.toThrow('E_REVISION_NOT_FOUND')
    await notes.setTitle(id, 'Renamed')
    await notes.flush()
    const event = (await notes.history(id)).find((e) => e.kind === 'title')!
    await expect(notes.restoreRevision(id, event.id)).rejects.toThrow('E_REVISION_NOT_FOUND')
  })

  it('compares a version with the current text, line by line', async () => {
    const { notes, id, older } = await twoVersions()
    expect(await notes.compareRevision(id, older.id)).toEqual([
      { kind: 'same', text: '# Plan' },
      { kind: 'same', text: '' },
      { kind: 'removed', text: 'first draft' },
      { kind: 'added', text: 'second draft, much longer' },
      { kind: 'same', text: '' },
    ])
  })
})

describe('metadata events', () => {
  it('logs a revision write that failed with the code it was refused with', async () => {
    const { storage, notes } = service()
    const id = await notes.create('Draft')
    // Storage behind Tauri rejects with the code Rust sends, as a string.
    storage.putRevision = () => Promise.reject('E_STORAGE_BUSY')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await notes.setStatus(id, 'active')
      await notes.flush()
      expect(warn).toHaveBeenCalledWith('W_REVISION_FAILED', 'E_STORAGE_BUSY')
    } finally {
      warn.mockRestore()
    }
  })

  it('records title, notebook, status and pin changes, newest first', async () => {
    const { storage, notes, books } = service()
    const id = await notes.create('Draft')
    await (await editorFor(notes, id)).type('text')
    await advance(REVISION_PAUSE_MS)
    const [version] = await bodies(storage, id)
    const book = await books.create('Work', null)
    await notes.setTitle(id, 'Pla')
    await advance(1000)
    await notes.setTitle(id, 'Plan')
    await advance(1000)
    await notes.setBook(id, book)
    await advance(1000)
    await notes.setStatus(id, 'active')
    await advance(1000)
    await notes.setPinned(id, true)
    await advance(1000)
    await notes.setBook(id, null)
    await notes.flush()

    const history = await notes.history(id)
    expect(
      history.map((e) => (e.kind === 'body' ? `body ${e.change}` : `${e.kind} ${e.value}`)),
    ).toEqual([`book null`, 'pinned 1', 'status active', `book ${book}`, 'title Plan', 'body null'])
    expect(history.at(-1)!.id).toBe(version!.id)
  })

  it('folds quick title edits into one event, and starts another after a pause', async () => {
    const { notes } = service()
    const id = await notes.create('')
    for (const title of ['P', 'Pl', 'Pla', 'Plan']) {
      await notes.setTitle(id, title)
      await advance(500)
    }
    await advance(REVISION_PAUSE_MS)
    await notes.setTitle(id, 'Plans')
    await notes.flush()
    const titles = (await notes.history(id)).map((e) => (e.kind === 'title' ? e.value : e.kind))
    expect(titles).toEqual(['Plans', 'Plan'])
  })

  it('records no event for title edits that end where they started', async () => {
    const { notes, storage } = service()
    const id = await notes.create('Plan')
    await notes.setTitle(id, 'Plan2')
    await advance(1000)
    await notes.setTitle(id, 'Plan')
    await advance(1000)
    await notes.flush()
    expect(await storage.listRevisions(id)).toEqual([])
  })

  it('lists a change still waiting for its save', async () => {
    const { notes } = service()
    const id = await notes.create('Plan')
    await notes.setPinned(id, true)
    expect((await notes.history(id)).map((e) => e.kind)).toEqual(['pinned'])
  })

  it('records nothing for a note created with its title, or for an unchanged field', async () => {
    const { notes, storage } = service()
    const id = await notes.create('Named')
    await notes.setStatus(id, 'none')
    await notes.setPinned(id, false)
    await notes.flush()
    expect(await storage.listRevisions(id)).toEqual([])
  })
})

describe('the SQLite adapter', () => {
  it('updates a revision only for its own note and kind, like the Rust store', async () => {
    const { storage, notes } = service()
    const a = await notes.create('A')
    const b = await notes.create('B')
    const id = '0192a6f0-0000-7000-8000-0000000000e1'
    const title = (noteId: string, value: string, kind: 'title' | 'status' = 'title') =>
      storage.putRevision({ id, noteId, kind, at: time, ydoc: null, length: null, value })
    await title(a, 'Dra')
    await title(a, 'Draft')
    await title(b, 'Other')
    await title(a, 'active', 'status')
    expect(await storage.getRevision(id)).toMatchObject({
      noteId: a,
      kind: 'title',
      value: 'Draft',
    })
    expect(await storage.listRevisions(b)).toEqual([])
  })
})
