import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  seedWelcome,
  splitTemplates,
  WELCOME_BOOK_ID,
  type NoteService,
  type NoteSummary,
} from '../../../core'
import { tempSqliteAdapter, type SqliteAdapter } from '../../../../tests/support/sqlite-adapter'
import { welcomeContent } from './content'
import { listSeeded } from './seed'

type Listed = { notes: NoteSummary[]; templates: NoteSummary[]; trash: []; books: [] }
const empty: Listed = { notes: [], templates: [], trash: [], books: [] }

const services: NoteService[] = []
afterEach(async () => {
  for (const notes of services.splice(0)) await notes.flush()
})

function library(storage: SqliteAdapter = tempSqliteAdapter('devot-launch-')) {
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  services.push(notes)
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  return { storage, notes, templates, clock }
}

/** One launch of the main window: what it lists, and how often it listed and seeded. */
async function launch({ storage, clock }: ReturnType<typeof library>) {
  const calls = { listed: 0, seeded: 0 }
  const list = async () => {
    calls.listed += 1
    const [listed, trash, books] = await Promise.all([
      storage.listNotes(),
      storage.listTrash(),
      storage.listBooks(),
    ])
    return { ...splitTemplates(listed), trash, books }
  }
  const seed = () => {
    calls.seeded += 1
    return seedWelcome({ storage, clock, content: welcomeContent() })
  }
  return { lists: await listSeeded(list, seed), calls }
}

describe('the first-launch notes at start', () => {
  it('seeds a new library once and lists its notes', async () => {
    const { lists, calls } = await launch(library())
    expect(calls).toEqual({ listed: 2, seeded: 1 })
    expect(lists.notes.map((n) => n.bookId)).toEqual([WELCOME_BOOK_ID, WELCOME_BOOK_ID])
    expect(lists.books.map((b) => b.id)).toEqual([WELCOME_BOOK_ID])
  })

  it('leaves the seed alone on the second launch and lists once', async () => {
    const lib = library()
    const first = await launch(lib)
    const second = await launch(lib)
    expect(second.calls).toEqual({ listed: 1, seeded: 0 })
    expect(second.lists.notes.map((n) => n.id)).toEqual(first.lists.notes.map((n) => n.id))
  })

  it('never seeds again once the welcome notes are in the Trash', async () => {
    const lib = library()
    const first = await launch(lib)
    for (const note of first.lists.notes) await lib.notes.trash(note.id)
    const second = await launch(lib)
    expect(second.calls).toEqual({ listed: 1, seeded: 0 })
    expect(second.lists.notes).toEqual([])
  })

  it('still seeds a library that holds templates alone', async () => {
    const lib = library()
    await lib.templates.create('Mine')
    const { lists, calls } = await launch(lib)
    expect(calls.seeded).toBe(1)
    expect(lists.notes).toHaveLength(2)
    expect(lists.templates.map((n) => n.title)).toEqual(['Mine'])
  })

  it('lists once when the seed fails, saying so by its code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const list = vi.fn<() => Promise<Listed>>(async () => empty)
    const lists = await listSeeded(list, async () => {
      throw new Error('E_TEST')
    })
    expect(lists.notes).toEqual([])
    expect(list).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('W_WELCOME_FAILED', 'E_TEST')
  })

  it('lists once when there is no seed to make', async () => {
    const list = vi.fn<() => Promise<Listed>>(async () => empty)
    await listSeeded(list)
    expect(list).toHaveBeenCalledOnce()
  })
})
