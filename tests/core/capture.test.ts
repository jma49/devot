import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureNote,
  captureShare,
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

// The smallest PNG: its signature and an IHDR chunk, enough for detectImage.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

describe('a share from another iPhone app', () => {
  it('makes a note of the title, the text and the link, saved before it resolves', async () => {
    const { path, notes, storage } = services()
    const { id, refused } = await captureShare(notes, storage, createIdGenerator(), {
      title: 'An article',
      text: 'Worth reading later.',
      url: 'https://example.com/a',
      images: [],
      bookId: null,
    })
    expect(refused).toEqual([])
    const other = openSqliteAdapter(path)
    open.push(other)
    expect(await other.getNote(id)).toMatchObject({
      title: 'An article',
      bodyMd: 'Worth reading later.\n\nhttps://example.com/a\n',
    })
  })

  it('leaves out a link the text already holds', async () => {
    const { notes, storage } = services()
    const { id } = await captureShare(notes, storage, createIdGenerator(), {
      title: '',
      text: 'see https://example.com/a',
      url: 'https://example.com/a',
      images: [],
      bookId: null,
    })
    expect((await notes.read(id)).bodyMd).toBe('see https://example.com/a\n')
  })

  it('stores each image as the note attachment and links it in the body', async () => {
    const { notes, storage } = services()
    const { id } = await captureShare(notes, storage, createIdGenerator(), {
      title: 'Photos',
      text: '',
      url: null,
      images: [
        { name: 'IMG_0001.jpg', data: PNG },
        { name: 'IMG_0002.jpg', data: PNG },
      ],
      bookId: null,
    })
    const body = (await notes.read(id)).bodyMd
    const links = [...body.matchAll(/!\[(IMG_000\d)\]\(devot:\/\/file\/([0-9a-f-]{36})\)/g)]
    expect(links.map((link) => link[1])).toEqual(['IMG_0001', 'IMG_0002'])
    for (const link of links) expect(await storage.syncFileData(link[2]!)).toEqual(PNG)
  })

  it('skips an image storage refuses, says why, and keeps the rest', async () => {
    const { notes, storage } = services()
    const { id, refused } = await captureShare(notes, storage, createIdGenerator(), {
      title: 'Mixed',
      text: 'text stays',
      url: null,
      images: [
        { name: 'not-an-image.jpg', data: new Uint8Array([1, 2, 3]) },
        { name: 'ok.png', data: PNG },
      ],
      bookId: null,
    })
    expect(refused).toEqual(['E_FILE_TYPE_REFUSED'])
    expect((await notes.read(id)).bodyMd).toMatch(/^text stays\n\n!\[ok\]\(devot:\/\/file\//)
  })

  it('files it in the notebook asked for', async () => {
    const { notes, books, storage } = services()
    const bookId = await books.create('Inbox', null)
    const { id } = await captureShare(notes, storage, createIdGenerator(), {
      title: 'Filed',
      text: '',
      url: null,
      images: [],
      bookId,
    })
    expect((await notes.read(id)).bookId).toBe(bookId)
  })

  it('refuses a share with nothing to keep and makes no note', async () => {
    const { notes, storage } = services()
    await expect(
      captureShare(notes, storage, createIdGenerator(), {
        title: ' ',
        text: '\n',
        url: null,
        images: [{ name: 'bad.jpg', data: new Uint8Array([0]) }],
        bookId: null,
      }),
    ).rejects.toThrow('E_SHARE_EMPTY')
    expect(await notes.list()).toEqual([])
  })
})
