import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  seedWelcome,
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
  const seed = () => seedWelcome({ storage, clock, newId, content })
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
