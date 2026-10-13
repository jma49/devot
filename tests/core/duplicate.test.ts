import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  duplicateNote,
  MAX_TITLE_CHARS,
  noteUri,
  UUID_V7,
  type NoteService,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Two images with different bytes, so a copy can be matched to its file.
const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 2])
const FILE_A = '0192a6f0-0000-7000-8000-00000000f001'
const FILE_B = '0192a6f0-0000-7000-8000-00000000f002'
const FILE_ID = /devot:\/\/file\/([0-9a-f-]{36})/g

interface StoredFile {
  noteId: string
  name: string
  mime: string
  data: Buffer
}

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function freshPath() {
  return join(tempDir('devot-duplicate-'), 'devot.sqlite')
}

function services(path = freshPath()) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    path,
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
  }
}

/** An editor replica that forwards its edits to the service, like the UI does. */
async function editorFor(notes: NoteService, id: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state, 'remote')
  const pending: Promise<void>[] = []
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') pending.push(notes.applyUpdate(id, update))
  })
  return { doc, text: doc.getText(BODY), settled: () => Promise.all(pending) }
}

function stateOf(ydoc: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, ydoc)
  return doc
}

describe('duplicating a note', () => {
  it('copies the title, body and notebook into a new note with a new ID', async () => {
    const { notes, books, storage } = services()
    const book = await books.create('Work', null)
    const id = await notes.create('Plan', book)
    const editor = await editorFor(notes, id)
    editor.text.insert(0, '# Plan\n\nFirst draft.')
    await editor.settled()
    await notes.flush()

    const copy = await notes.duplicate(id)
    expect(copy).toMatch(UUID_V7)
    expect(copy).not.toBe(id)
    const record = await storage.getNote(copy)
    expect(record).toMatchObject({ title: 'Plan', bookId: book, bodyMd: '# Plan\n\nFirst draft.' })
    expect(record?.deletedAt).toBeNull()
    expect((await notes.list()).map((n) => n.id).sort()).toEqual([id, copy].sort())
  })

  it('copies the body through Yjs, as the source document state', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Source')
    const editor = await editorFor(notes, id)
    editor.text.insert(0, 'hello world')
    editor.text.delete(0, 6)
    editor.text.insert(5, '!')
    await editor.settled()
    await notes.flush()

    const copy = await notes.duplicate(id)
    const source = await storage.getNote(id)
    const copied = await storage.getNote(copy)
    if (!source || !copied) throw new Error('missing note')
    const copyDoc = stateOf(copied.ydoc)
    expect(copyDoc.getText(BODY).toString()).toBe('world!')
    // The copy holds the source's Yjs items, not text inserted afresh.
    expect(Y.encodeStateVector(copyDoc)).toEqual(Y.encodeStateVector(stateOf(source.ydoc)))
  })

  it('includes edits that are not saved yet', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Draft')
    const editor = await editorFor(notes, id)
    editor.text.insert(0, 'typed just now')
    await editor.settled()
    await notes.setTitle(id, 'Draft 2')

    const copy = await notes.duplicate(id)
    await notes.flush()
    expect(await storage.getNote(copy)).toMatchObject({
      title: 'Draft 2',
      bodyMd: 'typed just now',
    })
  })

  it('keeps the copy and the original independent', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Shared start')
    const original = await editorFor(notes, id)
    original.text.insert(0, 'base')
    await original.settled()

    const copy = await notes.duplicate(id)
    const copyEditor = await editorFor(notes, copy)
    copyEditor.text.insert(4, ' copy')
    original.text.insert(4, ' original')
    await Promise.all([copyEditor.settled(), original.settled()])
    await notes.setTitle(copy, 'Renamed copy')
    await notes.flush()

    expect(await storage.getNote(id)).toMatchObject({
      title: 'Shared start',
      bodyMd: 'base original',
    })
    expect(await storage.getNote(copy)).toMatchObject({
      title: 'Renamed copy',
      bodyMd: 'base copy',
    })
  })

  it('survives a restart and indexes the links in the copied body', async () => {
    const first = services()
    const target = await first.notes.create('Target')
    const id = await first.notes.create('Linking')
    const editor = await editorFor(first.notes, id)
    editor.text.insert(0, `See [Target](${noteUri(target)})`)
    await editor.settled()
    const copy = await first.notes.duplicate(id)
    await first.notes.flush()
    const links = first.storage.db
      .prepare('SELECT source_id AS source FROM links WHERE target_id = ? ORDER BY source_id')
      .all(target) as { source: string }[]
    expect(links.map((l) => l.source)).toEqual([id, copy].sort())
    first.storage.close()
    open.length = 0

    const second = services(first.path)
    const reopened = await editorFor(second.notes, copy)
    expect(reopened.text.toString()).toBe(`See [Target](${noteUri(target)})`)
  })

  it('puts the copy in no notebook when the source notebook was deleted', async () => {
    const { notes, books, storage } = services()
    const book = await books.create('Old', null)
    const id = await notes.create('Orphan', book)
    await books.remove(book)

    const copy = await notes.duplicate(id)
    expect(await storage.getNote(copy)).toMatchObject({ bookId: null, bookHlc: '' })
    // The source keeps its notebook, so restoring it brings the note back.
    expect((await storage.getNote(id))?.bookId).toBe(book)
  })

  it('keeps the status and the tags, not the pin', async () => {
    const { notes, tags, storage } = services()
    const id = await notes.create('Pinned')
    await notes.setPinned(id, true)
    await notes.setStatus(id, 'active')
    const work = await tags.addToNote(id, 'work')
    const home = await tags.addToNote(id, 'home')
    await notes.flush()

    const copy = await duplicateNote({ notes, tags }, id, { tagIds: [work, home] })
    const summary = (await notes.list()).find((n) => n.id === copy)
    expect(summary).toMatchObject({ pinned: false, status: 'active' })
    expect([...(summary?.tagIds ?? [])].sort()).toEqual([work, home].sort())
    expect((await storage.getNote(copy))?.title).toBe('Pinned')
    // The original keeps all of it.
    expect((await notes.list()).find((n) => n.id === id)).toMatchObject({
      pinned: true,
      status: 'active',
    })
    // The status has its own clock, so it merges like any other change.
    expect((await storage.getNote(copy))?.statusHlc).not.toBe('')
  })

  it('titles the copy after the original and a suffix, never past the title limit', async () => {
    const { notes, tags, storage } = services()
    const id = await notes.create('Plan')
    const copy = await duplicateNote({ notes, tags }, id, { suffix: 'copy' })
    expect((await storage.getNote(copy))?.title).toBe('Plan copy')
    // A copy of a copy follows the same rule.
    const again = await duplicateNote({ notes, tags }, copy, { suffix: 'copy' })
    expect((await storage.getNote(again))?.title).toBe('Plan copy copy')

    const long = await notes.create('x'.repeat(MAX_TITLE_CHARS))
    const cut = await duplicateNote({ notes, tags }, long, { suffix: 'copy' })
    expect([...((await storage.getNote(cut))?.title ?? '')]).toHaveLength(MAX_TITLE_CHARS)

    // An untitled note stays untitled: its list row shows its first line.
    const untitled = await notes.create('')
    const plain = await duplicateNote({ notes, tags }, untitled, { suffix: 'copy' })
    expect((await storage.getNote(plain))?.title).toBe('')
  })

  it('leaves the title as it is without a suffix', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Same')
    expect((await storage.getNote(await notes.duplicate(id)))?.title).toBe('Same')
  })

  it('still makes the copy when a tag cannot be put on it', async () => {
    const { notes, tags } = services()
    const id = await notes.create('Tagged')
    const copy = await duplicateNote({ notes, tags }, id, {
      tagIds: ['0192a6f0-0000-7000-8000-00000000000b'],
    })
    expect((await notes.list()).map((n) => n.id)).toContain(copy)
  })

  it('gives the copy its own images, so purging the original keeps them', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Shots')
    await storage.putFile({ id: FILE_A, noteId: id, name: 'a.png' }, PNG_A)
    await storage.putFile({ id: FILE_B, noteId: id, name: 'b.png' }, PNG_B)
    const editor = await editorFor(notes, id)
    const body =
      `# Shots\n\n![a](devot://file/${FILE_A}) again ![](devot://file/${FILE_A}#half)\n` +
      `![b](devot://file/${FILE_B}#small)\n`
    editor.text.insert(0, body)
    await editor.settled()
    await notes.flush()
    const sourceState = (await storage.getNote(id))?.ydoc as Uint8Array

    const copy = await notes.duplicate(id)
    // The first write already shows the copies (the note is never stored
    // pointing at the original's files).
    const record = await storage.getNote(copy)
    if (!record) throw new Error('missing note')
    const ids = [...record.bodyMd.matchAll(FILE_ID)].map((m) => m[1] as string)
    expect(ids).toHaveLength(3)
    const [copyA, again, copyB] = ids as [string, string, string]
    expect(again).toBe(copyA)
    for (const fresh of [copyA, copyB]) {
      expect(fresh).toMatch(UUID_V7)
      expect([FILE_A, FILE_B]).not.toContain(fresh)
    }
    expect(copyA).not.toBe(copyB)
    // Only the IDs changed: the size presets stay.
    expect(record.bodyMd).toBe(body.replaceAll(FILE_A, copyA).replaceAll(FILE_B, copyB))
    // Through Yjs: the copy holds the source's items, plus the edits to the IDs.
    const copyDoc = stateOf(record.ydoc)
    expect(copyDoc.getText(BODY).toString()).toBe(record.bodyMd)
    const sourceClocks = Y.decodeStateVector(Y.encodeStateVector(stateOf(sourceState)))
    const copyClocks = Y.decodeStateVector(Y.encodeStateVector(copyDoc))
    for (const [client, clock] of sourceClocks) expect(copyClocks.get(client)).toBe(clock)
    // The original is unchanged.
    expect((await storage.getNote(id))?.bodyMd).toBe(body)

    await notes.trash(id)
    await notes.purge(id)
    const file = (fileId: string) =>
      storage.db
        .prepare('SELECT note_id AS noteId, name, mime, data FROM files WHERE id = ?')
        .get(fileId) as StoredFile | undefined
    expect(file(copyA)).toMatchObject({ noteId: copy, name: 'a.png', mime: 'image/png' })
    expect(new Uint8Array(file(copyA)?.data ?? [])).toEqual(PNG_A)
    expect(file(copyB)).toMatchObject({ noteId: copy, name: 'b.png', mime: 'image/png' })
    expect(new Uint8Array(file(copyB)?.data ?? [])).toEqual(PNG_B)
    expect(file(FILE_A)).toBeUndefined()
    expect(file(FILE_B)).toBeUndefined()

    // The copy reopens with its own links after the original is gone.
    await notes.release(copy)
    expect((await editorFor(notes, copy)).text.toString()).toBe(record.bodyMd)
  })

  it('leaves no copy behind when its images cannot be copied, and reports why', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Shot')
    await storage.putFile({ id: FILE_A, noteId: id, name: 'a.png' }, PNG_A)
    await notes.setBody(id, `![](devot://file/${FILE_A})`)
    await notes.flush()
    // A real failure inside the copy's write, on the real database.
    storage.db.exec(
      "CREATE TEMP TRIGGER no_copies BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'E_DISK_FULL'); END",
    )
    await expect(notes.duplicate(id)).rejects.toThrow('E_DISK_FULL')
    expect((await storage.listNotes()).map((n) => n.id)).toEqual([id])
    const files = storage.db.prepare('SELECT id, note_id AS noteId FROM files').all()
    expect(files).toEqual([{ id: FILE_A, noteId: id }])
  })

  it('refuses a note that is in the trash or does not exist', async () => {
    const { notes } = services()
    const id = await notes.create('Gone')
    await notes.trash(id)
    await expect(notes.duplicate(id)).rejects.toThrow('E_NOTE_NOT_FOUND')
    await expect(notes.duplicate('0192a6f0-0000-7000-8000-00000000000a')).rejects.toThrow(
      'E_NOTE_NOT_FOUND',
    )
  })
})
