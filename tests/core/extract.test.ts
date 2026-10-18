import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  noteUri,
  UUID_V7,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const FILE_A = '0192a6f0-0000-7000-8000-00000000f001'
const FILE_B = '0192a6f0-0000-7000-8000-00000000f002'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function services() {
  const path = join(tempDir('devot-extract-'), 'devot.sqlite')
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
  }
}

describe('a new note from selected text', () => {
  it('takes its title from the first line and the text as its body, in the same notebook', async () => {
    const { notes, books, storage } = services()
    const book = await books.create('Work', null)
    const source = await notes.create('Meeting', book)

    const made = await notes.extract(source, '## Follow-ups\n\n- Send the deck\n')
    expect(made.id).toMatch(UUID_V7)
    expect(made.title).toBe('Follow-ups')
    await notes.flush()
    expect(await storage.getNote(made.id)).toMatchObject({
      title: 'Follow-ups',
      bookId: book,
      bodyMd: '## Follow-ups\n\n- Send the deck\n',
      deletedAt: null,
    })
  })

  it('takes a title given instead, stored with the note in the same write', async () => {
    const { notes, storage } = services()
    const source = await notes.create('Source')
    const made = await notes.extract(source, 'https://example.com/a', 'Foo')
    expect(made.title).toBe('Foo')
    // Stored at once: a list read right away shows the title.
    expect(await storage.getNote(made.id)).toMatchObject({
      title: 'Foo',
      bodyMd: 'https://example.com/a',
    })
  })

  it('writes the body through Yjs, as operations on the new note', async () => {
    const { notes, storage } = services()
    const source = await notes.create('Source')
    const made = await notes.extract(source, 'Line one\r\nLine two')
    await notes.flush()
    const record = await storage.getNote(made.id)
    if (!record) throw new Error('missing note')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, record.ydoc)
    // Line breaks become `\n`, so the editor and Yjs count alike.
    expect(doc.getText(BODY).toString()).toBe('Line one\nLine two')
    expect(record.bodyMd).toBe('Line one\nLine two')
  })

  it('puts the note in no notebook when the source has none or its notebook was deleted', async () => {
    const { notes, books, storage } = services()
    const loose = await notes.create('Loose')
    const fromLoose = await notes.extract(loose, 'Idea')
    expect((await storage.getNote(fromLoose.id))?.bookId).toBeNull()

    const book = await books.create('Old', null)
    const filed = await notes.extract(await notes.create('Filed', book), 'Kept')
    expect((await storage.getNote(filed.id))?.bookId).toBe(book)
    const orphan = await notes.create('Orphan', book)
    await books.remove(book)
    const fromOrphan = await notes.extract(orphan, 'Idea')
    expect((await storage.getNote(fromOrphan.id))?.bookId).toBeNull()
    await notes.flush()
  })

  it('indexes the links the moved text holds', async () => {
    const { notes, storage } = services()
    const target = await notes.create('Target')
    const source = await notes.create('Source')
    const made = await notes.extract(source, `About [Target](${noteUri(target)})`)
    await notes.flush()
    const links = storage.db
      .prepare('SELECT source_id AS source FROM links WHERE target_id = ?')
      .all(target) as { source: string }[]
    expect(links.map((l) => l.source)).toEqual([made.id])
  })

  it('stores the note with its body at once, never empty', async () => {
    const { notes, storage } = services()
    const source = await notes.create('Source')
    const made = await notes.extract(source, 'Moved text')
    // No flush: the first write already holds the body (search and the list read it).
    expect(await storage.getNote(made.id)).toMatchObject({ bodyMd: 'Moved text' })
    expect((await notes.search('Moved')).map((n) => n.id)).toEqual([made.id])
  })

  it('gives the note its own copies of the images the moved text shows', async () => {
    const { notes, storage } = services()
    const source = await notes.create('Source')
    await storage.putFile({ id: FILE_A, noteId: source, name: 'shot.png' }, PNG)
    await storage.putFile({ id: FILE_B, noteId: source, name: 'other.png' }, PNG)
    const moved = `## Shot\n\n![shot](devot://file/${FILE_A}) and again ![](devot://file/${FILE_A}#half)\n`
    const made = await notes.extract(source, moved)
    await notes.flush()

    const body = (await storage.getNote(made.id))?.bodyMd ?? ''
    const ids = [...body.matchAll(/devot:\/\/file\/([0-9a-f-]{36})/g)].map((m) => m[1])
    expect(ids).toHaveLength(2)
    const copy = ids[0] as string
    expect(ids[1]).toBe(copy)
    expect(copy).toMatch(UUID_V7)
    expect(copy).not.toBe(FILE_A)
    expect(body).toBe(moved.replaceAll(FILE_A, copy))

    // Deleting the source for good leaves the new note's image in place.
    await notes.trash(source)
    await notes.purge(source)
    const file = storage.db
      .prepare('SELECT note_id AS noteId, name, mime, size, data FROM files WHERE id = ?')
      .get(copy) as { noteId: string; name: string; mime: string; size: number; data: Buffer }
    expect(file).toMatchObject({ noteId: made.id, name: 'shot.png', mime: 'image/png' })
    expect(new Uint8Array(file.data)).toEqual(PNG)
    expect(file.size).toBe(PNG.length)
    // Only the image the text shows was copied; the source's own went with it.
    const count = storage.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('still makes the note when an image the text shows is gone', async () => {
    const { notes, storage } = services()
    const source = await notes.create('Source')
    const made = await notes.extract(source, `Gone ![x](devot://file/${FILE_A})`)
    expect((await storage.getNote(made.id))?.title).toBe('Gone ![x](devot://file/' + FILE_A + ')')
    const count = storage.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('leaves no note behind when its images cannot be copied', async () => {
    const { notes, storage } = services()
    const source = await notes.create('Source')
    await storage.putFile({ id: FILE_A, noteId: source, name: 'shot.png' }, PNG)
    // A real failure inside the copy's write, on the real database.
    storage.db.exec(
      "CREATE TEMP TRIGGER no_copies BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'E_DISK_FULL'); END",
    )
    await expect(notes.extract(source, `![](devot://file/${FILE_A})`)).rejects.toThrow(
      'E_DISK_FULL',
    )
    expect((await storage.listNotes()).map((n) => n.id)).toEqual([source])
  })

  it('refuses a source note that does not exist', async () => {
    const { notes } = services()
    await expect(notes.extract('0192a6f0-0000-7000-8000-00000000000a', 'x')).rejects.toThrow(
      'E_NOTE_NOT_FOUND',
    )
  })
})
