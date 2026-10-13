import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBookTree,
  bookCounts,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  notesInBook,
  type BookRecord,
  type BookService,
  type NoteService,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup(node = 'mac1', path = join(tempDir('devot-books-'), 'devot.sqlite')) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock(node)
  const newId = createIdGenerator()
  const books: BookService = createBookService({ storage, clock, newId })
  const notes: NoteService = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  return { storage, books, notes, path }
}

const names = (records: BookRecord[]) => records.map((b) => b.name).sort()

describe('notebooks on SQLite', () => {
  it('creates, renames and lists notebooks', async () => {
    const { books } = setup()
    const work = await books.create('Work', null)
    await books.create('Reading', null)
    await books.rename(work, 'Job')
    expect(names(await books.list())).toEqual(['Job', 'Reading'])
  })

  it('refuses empty, multi-line or overlong names', async () => {
    const { books } = setup()
    for (const name of ['', '   ', 'a\nb', 'x'.repeat(201)]) {
      await expect(books.create(name, null)).rejects.toThrow('E_BOOK_NAME_INVALID')
    }
    expect(await books.create('  Trimmed  ', null)).toBeTruthy()
    expect(names(await books.list())).toEqual(['Trimmed'])
  })

  it('nests notebooks and builds the tree in the order they were made', async () => {
    const { books } = setup()
    const work = await books.create('Work', null)
    const devot = await books.create('Devot', work)
    await books.create('Weekly', work)
    await books.create('Archive', devot)
    const tree = buildBookTree(await books.list())
    expect(tree.map((n) => n.name)).toEqual(['Work'])
    expect(tree[0]?.children.map((n) => n.name)).toEqual(['Devot', 'Weekly'])
    expect(tree[0]?.children[0]?.children.map((n) => [n.name, n.depth])).toEqual([['Archive', 2]])
  })

  it('moves a notebook, but never into itself or its own descendants', async () => {
    const { books } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', a)
    const c = await books.create('C', b)
    await expect(books.move(a, c)).rejects.toThrow('E_BOOK_CYCLE')
    await expect(books.move(a, a)).rejects.toThrow('E_BOOK_CYCLE')
    await books.move(c, null)
    expect(buildBookTree(await books.list()).map((n) => n.name)).toEqual(['A', 'C'])
  })

  it('refuses a parent that does not exist', async () => {
    const { books } = setup()
    await expect(books.create('Orphan', '0192a6f0-0000-7000-8000-00000000dead')).rejects.toThrow(
      'E_BOOK_NOT_FOUND',
    )
  })

  it('deletes a notebook with its sub-notebooks and keeps their notes', async () => {
    const { books, notes } = setup()
    const work = await books.create('Work', null)
    const devot = await books.create('Devot', work)
    const keep = await books.create('Keep', null)
    const inDevot = await notes.create('In Devot', devot)
    await notes.create('In Keep', keep)
    await books.remove(work)
    expect(names(await books.list())).toEqual(['Keep'])
    const summaries = await notes.list()
    expect(summaries.map((n) => n.title).sort()).toEqual(['In Devot', 'In Keep'])
    // Its notebook is gone, so the note shows under no notebook.
    expect(notesInBook(summaries, await books.list(), null).map((n) => n.id)).toEqual([inDevot])
  })

  it('moves a note between notebooks and to none', async () => {
    const { books, notes } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const id = await notes.create('Note', a)
    await notes.setBook(id, b)
    await notes.flush()
    expect((await notes.list())[0]?.bookId).toBe(b)
    await notes.setBook(id, null)
    await notes.flush()
    expect((await notes.list())[0]?.bookId).toBeNull()
  })

  it('filters the note list by a notebook and its descendants, and counts them', async () => {
    const { books, notes } = setup()
    const work = await books.create('Work', null)
    const devot = await books.create('Devot', work)
    const reading = await books.create('Reading', null)
    await notes.create('w', work)
    await notes.create('d1', devot)
    await notes.create('d2', devot)
    await notes.create('r', reading)
    await notes.create('loose', null)
    const all = await notes.list()
    const records = await books.list()
    const titles = (bookId: string | null) =>
      notesInBook(all, records, bookId)
        .map((n) => n.title)
        .sort()
    expect(titles(work)).toEqual(['d1', 'd2', 'w'])
    expect(titles(devot)).toEqual(['d1', 'd2'])
    expect(titles(null)).toEqual(['loose'])
    const counts = bookCounts(all, records)
    expect([counts.get(work), counts.get(devot), counts.get(reading)]).toEqual([3, 2, 1])
  })
})

describe('notebook metadata merges per field (HLC)', () => {
  it('keeps the newer value of each field when a stale copy is written', async () => {
    const { storage, books } = setup()
    const id = await books.create('Old name', null)
    const [stale] = await books.list()
    await books.rename(id, 'New name')
    const parent = await books.create('Parent', null)
    // A stale copy with an older name HLC but a newer parent change.
    await storage.putBook({ ...stale!, parentId: parent, parentHlc: '9999999999999999-0000-zz' })
    const merged = (await books.list()).find((b) => b.id === id)
    expect(merged?.name).toBe('New name')
    expect(merged?.parentId).toBe(parent)
  })

  it('keeps a note in its newer notebook when an older copy of the note is saved', async () => {
    const { storage, books, notes } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const id = await notes.create('Note', a)
    const stale = (await storage.getNote(id))!
    await notes.setBook(id, b)
    await notes.flush()
    await storage.putNote({ ...stale, title: 'Stale write' })
    const now = (await storage.getNote(id))!
    expect(now.bookId).toBe(b)
    expect(now.title).toBe('Note')
  })

  it('does not bring a deleted notebook back from a stale copy', async () => {
    const { storage, books } = setup()
    const id = await books.create('Gone', null)
    const [stale] = await books.list()
    await books.remove(id)
    await storage.putBook(stale!)
    expect(await books.list()).toEqual([])
  })
})

describe('Allow AI Access', () => {
  it('is off for a new notebook and switches per notebook, not for sub-notebooks', async () => {
    const { books } = setup()
    const work = await books.create('Work', null)
    const inside = await books.create('Inside', work)
    expect((await books.list()).map((b) => b.aiAccess)).toEqual([false, false])
    await books.setAiAccess(work, true)
    const byId = new Map((await books.list()).map((b) => [b.id, b]))
    expect(byId.get(work)?.aiAccess).toBe(true)
    expect(byId.get(inside)?.aiAccess).toBe(false)
    await books.setAiAccess(work, false)
    expect((await books.list()).find((b) => b.id === work)?.aiAccess).toBe(false)
    await expect(books.setAiAccess('missing', true)).rejects.toThrow('E_BOOK_NOT_FOUND')
  })

  it('merges by HLC: a stale copy never turns the switch back', async () => {
    const { storage, books } = setup()
    const id = await books.create('Work', null)
    const [stale] = await books.list()
    await books.setAiAccess(id, true)
    // A stale copy with a newer name but the switch's older value.
    await storage.putBook({ ...stale!, name: 'Job', nameHlc: '9999999999999999-0000-zz' })
    const merged = (await books.list())[0]!
    expect(merged.name).toBe('Job')
    expect(merged.aiAccess).toBe(true)
    // Renaming does not touch the switch.
    await books.rename(id, 'Office')
    expect((await books.list())[0]?.aiAccess).toBe(true)
  })

  it('shows on the tree nodes', async () => {
    const { books } = setup()
    const id = await books.create('Work', null)
    await books.setAiAccess(id, true)
    expect(buildBookTree(await books.list())[0]?.aiAccess).toBe(true)
  })
})

describe('tree building is safe against bad data from sync', () => {
  const book = (id: string, parentId: string | null, name = id): BookRecord => ({
    id,
    name,
    nameHlc: 'h',
    parentId,
    parentHlc: 'h',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    sortKey: 'a0',
    sortKeyHlc: '',
  })

  it('shows notebooks with a missing parent at the top level', () => {
    expect(buildBookTree([book('a', 'gone')]).map((n) => n.id)).toEqual(['a'])
  })

  it('breaks a parent cycle deterministically, keeping every notebook', () => {
    const tree = buildBookTree([book('a', 'b'), book('b', 'a'), book('c', 'a')])
    const ids: string[] = []
    const walk = (nodes: typeof tree) =>
      nodes.forEach((n) => {
        ids.push(n.id)
        walk(n.children)
      })
    walk(tree)
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
    expect(tree.map((n) => n.id)).toEqual(['a'])
  })
})
