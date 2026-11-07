import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
} from '../../src/core'
import { TEMPLATES_BOOK_ID } from '../../src/core/templatesBook'
import {
  discardNewNote,
  makeNewNote,
  newNoteBook,
  untouched,
} from '../../src/renderer/src/phone/newNote'
import { tempSqliteAdapter } from '../support/sqlite-adapter'

function phoneCore() {
  const storage = tempSqliteAdapter('devot-phone-new-')
  const clock = createClock('phone1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  const core = {
    create: (title: string, bookId: string | null) => notes.create(title, bookId),
    createTemplate: () => templates.create(),
    discardEmpty: (id: string) => notes.discardEmpty(id),
  }
  const summary = async (id: string) => {
    await notes.flush()
    return (await templates.listWithNotes()).notes.find((n) => n.id === id)
  }
  return { storage, notes, books, tags, templates, core, summary }
}

async function type(notes: ReturnType<typeof phoneCore>['notes'], id: string, text: string) {
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  const before = Y.encodeStateVector(doc)
  doc.getText(BODY).insert(0, text)
  await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
  await notes.flush()
}

describe('New Note on the iPhone, on SQLite', () => {
  it('makes an empty note with status none in the notebook the list shows, else the default', async () => {
    const { core, books, summary } = phoneCore()
    const work = await books.create('Work', null)
    const home = await books.create('Home', null)
    const all = await books.list()
    const shown = newNoteBook({ view: { kind: 'book', id: work }, status: 'all' }, home, all)
    const id = await makeNewNote(core, 'note', shown)
    expect(await summary(id)).toMatchObject({ title: '', bookId: work, status: 'none' })
    const fromAll = newNoteBook({ view: { kind: 'all' }, status: 'active' }, home, all)
    expect((await summary(await makeNewNote(core, 'note', fromAll)))?.bookId).toBe(home)
    expect(newNoteBook(null, 'gone', all)).toBeNull()
  })

  it('makes a template from Templates', async () => {
    const { core, templates } = phoneCore()
    const id = await makeNewNote(core, 'template', null)
    const listed = await templates.listWithNotes()
    expect(listed.templates.find((n) => n.id === id)?.bookId).toBe(TEMPLATES_BOOK_ID)
    expect(listed.notes.map((n) => n.id)).not.toContain(id)
  })

  it('discards a note left untouched, for good and without the Trash', async () => {
    const { core, notes, storage, summary } = phoneCore()
    const id = await makeNewNote(core, 'note', null)
    expect(untouched({ bookId: null }, await summary(id))).toBe(true)
    await notes.open(id)
    expect(await discardNewNote(core, id)).toBe(true)
    expect(await notes.list()).toEqual([])
    expect(await notes.listTrash()).toEqual([])
    expect(await storage.getNote(id, { trashed: true })).toBeNull()
  })

  it('counts a title or a chip changed as touched', async () => {
    const { core, notes, books, tags, summary } = phoneCore()
    const made = { bookId: null }
    const titled = await makeNewNote(core, 'note', null)
    await notes.setTitle(titled, 'Plans')
    expect(untouched(made, await summary(titled))).toBe(false)
    const moved = await makeNewNote(core, 'note', null)
    await notes.setBook(moved, await books.create('Work', null))
    expect(untouched(made, await summary(moved))).toBe(false)
    const tagged = await makeNewNote(core, 'note', null)
    await tags.addToNote(tagged, 'idea')
    expect(untouched(made, await summary(tagged))).toBe(false)
    const started = await makeNewNote(core, 'note', null)
    await notes.setStatus(started, 'active')
    expect(untouched(made, await summary(started))).toBe(false)
  })

  it('keeps a note sync wrote a body into, and logs the refusal by its code', async () => {
    const { core, notes } = phoneCore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await makeNewNote(core, 'note', null)
    await type(notes, id, 'From the Mac')
    expect(await discardNewNote(core, id)).toBe(false)
    expect((await notes.list()).map((n) => n.id)).toEqual([id])
    expect(warn).toHaveBeenCalledWith('W_PHONE_DISCARD_REFUSED code=E_NOTE_NOT_TRASHED')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('From the Mac')
    warn.mockRestore()
  })
})
