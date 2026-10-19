// Only the most recently used notes stay in memory once unused. A note leaves only when nothing can be lost
// (unsaved or failed change, write under way, open editor); unversioned typing becomes a version first.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  NOTES_IN_MEMORY,
  type NoteRecord,
  type NoteService,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
const services: NoteService[] = []
afterEach(async () => {
  for (const notes of services.splice(0)) await notes.flush().catch(() => {})
  open.splice(0).forEach((a) => a.close())
})

/** Note service on a fresh SQLite file: counts storage reads, can hold the next read, refuses writes while `refuse` says so; time is `now`. */
function setup(path = join(tempDir('devot-memory-'), 'devot.sqlite')) {
  const sqlite = openSqliteAdapter(path)
  open.push(sqlite)
  const reads: string[] = []
  let gate: Promise<void> | undefined
  let refuse = (_record: NoteRecord) => false
  const storage = Object.assign(Object.create(sqlite) as SqliteAdapter, {
    async getNote(id: string, options?: { trashed?: boolean }) {
      reads.push(id)
      const wait = gate
      gate = undefined
      if (wait) await wait
      return sqlite.getNote(id, options)
    },
    async putNote(record: NoteRecord) {
      if (refuse(record)) throw new Error('E_TEST_WRITE')
      await sqlite.putNote(record)
    },
  })
  const clock = { now: Date.now() }
  const notes = createNoteService({
    storage,
    clock: createClock('mac1', () => clock.now),
    newId: createIdGenerator(),
    now: () => clock.now,
    saveDelayMs: 5,
    retryDelayMs: 60_000,
  })
  services.push(notes)
  return {
    notes,
    sqlite,
    path,
    clock,
    reads() {
      const counted = reads.splice(0)
      return (id: string) => counted.filter((r) => r === id).length
    },
    /** The next note read waits until the returned function is called. */
    holdNextRead() {
      let release = () => {}
      gate = new Promise((resolve) => (release = resolve))
      return release
    },
    refuseWrites(when: (record: NoteRecord) => boolean) {
      refuse = when
    },
  }
}

/** `count` saved notes made by a separate service, so none is in memory. */
async function library(path: string, count: number) {
  const { notes } = setup(path)
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = await notes.create(`Note ${i}`)
    await notes.setBody(id, `body ${i}`)
    ids.push(id)
  }
  await notes.flush()
  return ids
}

async function browse(notes: NoteService, id: string) {
  notes.hold(id)
  await notes.open(id)
  notes.unhold(id)
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

async function edit(notes: NoteService, id: string, typed: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state)
  const before = Y.encodeStateVector(doc)
  const text = doc.getText(BODY)
  text.insert(text.length, typed)
  return Y.encodeStateAsUpdate(doc, before)
}

describe('notes in memory', () => {
  it('keeps only the most recently used notes once nothing uses them', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const ids = await library(path, 50)
    const s = setup(path)
    for (const id of ids) await browse(s.notes, id)
    let read = s.reads()
    expect(ids.map(read)).toEqual(ids.map(() => 1))

    const recent = ids.slice(-NOTES_IN_MEMORY)
    for (const id of recent) await browse(s.notes, id)
    read = s.reads()
    expect(recent.map(read)).toEqual(recent.map(() => 0))
    await browse(s.notes, ids[0]!)
    expect(s.reads()(ids[0]!)).toBe(1)
  })

  it('never lets go of a note an editor holds', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const [shown, ...others] = await library(path, 30)
    const s = setup(path)
    s.notes.hold(shown!)
    await s.notes.open(shown!)
    for (const id of others) await browse(s.notes, id)
    s.reads()
    await s.notes.open(shown!)
    expect(s.reads()(shown!)).toBe(0)
    s.notes.unhold(shown!)
  })

  it('keeps a note with unsaved, failed or pending changes until they are saved', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const [failing, typed, ...others] = await library(path, 30)
    const s = setup(path)
    s.refuseWrites((record) => record.id === failing)
    await s.notes.setTitle(failing!, 'Renamed, not saved yet')
    await s.notes.applyUpdate(typed!, await edit(s.notes, typed!, ' and more'))
    await vi.waitFor(async () =>
      expect(await s.sqlite.getNote(typed!)).toMatchObject({
        bodyMd: expect.stringMatching(/more$/),
      }),
    )
    for (const id of others) await browse(s.notes, id)
    s.reads()
    expect((await s.notes.open(failing!)).title).toBe('Renamed, not saved yet')
    expect(s.reads()(failing!)).toBe(0)
    s.refuseWrites(() => false)
    await s.notes.flush()
    expect((await s.sqlite.getNote(failing!))?.title).toBe('Renamed, not saved yet')
  })

  it('keeps typing not kept as a version yet as one when the note leaves memory', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const [typed, ...others] = await library(path, 30)
    const s = setup(path)
    await s.notes.applyUpdate(typed!, await edit(s.notes, typed!, ' typed today'))
    await s.notes.flush()
    for (const id of others) await browse(s.notes, id)
    await s.notes.flush()
    const versions = (await s.sqlite.listRevisions(typed!)).filter((r) => r.kind === 'body')
    const newest = await s.sqlite.getRevision(versions[0]!.id)
    expect(textOf(newest!.ydoc!)).toBe('body 0 typed today')
  })

  it('keeps a note whose title is still being typed, so its rename stays one event', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const [renamed, ...others] = await library(path, 30)
    const s = setup(path)
    await s.notes.setTitle(renamed!, 'Pla')
    await s.notes.flush()
    for (const id of others) await browse(s.notes, id)
    s.clock.now += 1000
    await s.notes.setTitle(renamed!, 'Plan')
    await s.notes.flush()
    const events = (await s.sqlite.listRevisions(renamed!)).filter((r) => r.kind === 'title')
    expect(events.map((e) => e.value)).toEqual(['Plan'])
  })

  it('reads a note again after it left, with what was saved and written meanwhile', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const [note, ...others] = await library(path, 30)
    const s = setup(path)
    // An editor keeps its replica from before the note left memory.
    const replica = new Y.Doc()
    Y.applyUpdate(replica, (await s.notes.open(note!)).state)
    for (const id of others) await browse(s.notes, id)
    // Another process writes the note meanwhile.
    const other = setup(path)
    await other.notes.setBody(note!, 'body 0, edited elsewhere')
    await other.notes.flush()
    await s.notes.mergeStored()

    const before = Y.encodeStateVector(replica)
    replica.getText(BODY).insert(0, '(typed) ')
    await s.notes.applyUpdate(note!, Y.encodeStateAsUpdate(replica, before))
    await s.notes.flush()
    expect((await s.sqlite.getNote(note!))?.bodyMd).toBe('(typed) body 0, edited elsewhere')
  })

  it('loads a note once when two changes ask for it at the same time', async () => {
    const path = join(tempDir('devot-memory-'), 'devot.sqlite')
    const [note] = await library(path, 1)
    const s = setup(path)
    const update = await edit(setup(path).notes, note!, ' typed')
    const release = s.holdNextRead()
    const typing = s.notes.applyUpdate(note!, update)
    const renaming = s.notes.setTitle(note!, 'Renamed')
    release()
    await Promise.all([typing, renaming])
    await s.notes.flush()
    expect(s.reads()(note!)).toBe(1)
    expect(await s.sqlite.getNote(note!)).toMatchObject({
      title: 'Renamed',
      bodyMd: 'body 0 typed',
    })
  })
})
