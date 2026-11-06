import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  seedWelcome,
  type StorageAdapter,
  WELCOME_BOOK_ID,
  type WelcomeContent,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const A = '00000000-0000-7000-8000-0000000000a1'
const B = '00000000-0000-7000-8000-0000000000a2'
const content: WelcomeContent = {
  bookName: 'Getting started',
  notes: [
    { id: A, title: 'Welcome', body: '# Hello\n', pinned: true },
    { id: B, title: 'Example', body: 'Text\n' },
  ],
}

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-welcome-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const seed = () => seedWelcome({ storage, clock, content })
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  return { storage, seed, notes }
}

describe('first-launch notes', () => {
  it('fills an empty library once, in their own notebook', async () => {
    const { storage, seed } = setup()
    expect(await seed()).toBe(A)
    const listed = await storage.listNotes()
    expect(listed.map((n) => n.id).sort()).toEqual([A, B])
    expect(listed.every((n) => n.bookId === WELCOME_BOOK_ID)).toBe(true)
    expect(listed.find((n) => n.id === A)?.pinned).toBe(true)
    expect((await storage.getNote(B))?.bodyMd).toBe('Text\n')
    expect((await storage.listBooks()).map((b) => b.name)).toEqual(['Getting started'])
  })

  it('writes each note once, so its dates say it is as seeded', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-welcome-'), 'devot.sqlite'))
    open.push(storage)
    let at = 1_000
    const now = () => (at += 7)
    await seedWelcome({
      storage,
      clock: createClock('mac1'),
      now,
      content,
    })
    const listed = await storage.listNotes()
    expect(listed).toHaveLength(2)
    expect(listed.map((n) => n.updatedAt)).toEqual(listed.map((n) => n.createdAt))
    expect(listed.find((n) => n.id === A)?.pinned).toBe(true)
  })

  // The app's store writes its own bundled copy in that call, the one write a library without a licence takes (src-tauri/src/commands/welcome.rs).
  it('seeds through one storage call, never a write the licence gates', async () => {
    const { storage } = setup()
    const refuse = () => Promise.reject(new Error('E_LICENCE_REQUIRED'))
    const locked: StorageAdapter = {
      ...storage,
      putNote: refuse,
      putBook: refuse,
      putBooks: refuse,
      putFile: refuse,
      seedWelcome: (seed) => storage.seedWelcome(seed),
    }
    expect(await seedWelcome({ storage: locked, clock: createClock('mac1'), content })).toBe(A)
    expect((await storage.listNotes()).map((n) => n.id).sort()).toEqual([A, B])
  })

  it('stamps the whole seed with one clock time', async () => {
    const { storage, seed } = setup()
    await seed()
    const [book] = await storage.listBooks()
    const note = await storage.getNote(A)
    expect(new Set([book?.nameHlc, note?.titleHlc, note?.bookHlc, note?.pinnedHlc]).size).toBe(1)
  })

  it('leaves a library that already has notes alone', async () => {
    const { storage, seed, notes } = setup()
    await notes.create('Mine')
    await notes.flush()
    expect(await seed()).toBeNull()
    expect(await storage.listNotes()).toHaveLength(1)
    expect(await storage.listBooks()).toEqual([])
  })

  it('does not come back after the notes are deleted', async () => {
    const { storage, seed, notes } = setup()
    await seed()
    await notes.trash(A)
    await notes.trash(B)
    expect(await seed()).toBeNull()
    // Gone for good: the fixed IDs stay taken, so nothing is written again.
    await notes.emptyTrash()
    await seed()
    expect(await storage.listNotes()).toEqual([])
  })
})
