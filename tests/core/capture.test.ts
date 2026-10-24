import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureNote,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function services() {
  const path = join(tempDir('devot-capture-'), 'devot.sqlite')
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    path,
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 60_000 }),
    books: createBookService({ storage, clock, newId }),
  }
}

describe('quick capture', () => {
  it('saves a note with its title and body in the chosen notebook before it resolves', async () => {
    const { path, notes, books } = services()
    const bookId = await books.create('Inbox', null)
    const id = await captureNote(notes, {
      title: 'Groceries',
      markdown: '- milk\n- bread\n',
      bookId,
    })
    // Read back from another connection: nothing waits for the 60 s autosave.
    const other = openSqliteAdapter(path)
    open.push(other)
    const stored = await other.getNote(id)
    expect(stored).toMatchObject({
      title: 'Groceries',
      bodyMd: '- milk\n- bread\n',
      bookId,
    })
  })

  it('takes a body without a title, and a title without a body, into no notebook', async () => {
    const { notes } = services()
    const untitled = await captureNote(notes, {
      title: '',
      markdown: 'just a thought',
      bookId: null,
    })
    const bare = await captureNote(notes, { title: 'Call back', markdown: '', bookId: null })
    expect(await notes.read(untitled)).toMatchObject({
      title: '',
      bodyMd: 'just a thought',
      bookId: null,
    })
    expect(await notes.read(bare)).toMatchObject({ title: 'Call back', bodyMd: '', bookId: null })
  })

  it('clips the title as every new note is clipped', async () => {
    const { notes } = services()
    const id = await captureNote(notes, { title: 'one\ntwo', markdown: '', bookId: null })
    expect((await notes.read(id)).title).toBe('one two')
  })

  it('refuses an empty capture and makes no note', async () => {
    const { notes } = services()
    await expect(captureNote(notes, { title: ' ', markdown: '\n', bookId: null })).rejects.toThrow(
      'E_QUICK_CAPTURE_EMPTY',
    )
    expect(await notes.list()).toEqual([])
  })

  it('refuses a notebook that is gone and makes no note, so the window keeps the text', async () => {
    const { notes, books } = services()
    const bookId = await books.create('Old', null)
    await books.remove(bookId)
    await expect(captureNote(notes, { title: 'Lost?', markdown: 'no', bookId })).rejects.toThrow(
      'E_BOOK_NOT_FOUND',
    )
    expect(await notes.list()).toEqual([])
  })
})
