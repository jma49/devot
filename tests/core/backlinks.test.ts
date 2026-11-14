import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  MAX_BACKLINKS,
  TEMPLATES_BOOK_ID,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  findBacklinks,
  formatHlc,
  noteLink,
  type NoteRecord,
  type StorageAdapter,
} from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => {
  open.splice(0).forEach((a) => a.close())
  restoreLocalStorage()
})

function sqlite() {
  const storage = openSqliteAdapter(join(tempDir('devot-backlinks-'), 'devot.sqlite'))
  open.push(storage)
  return storage
}

function setup(storage: StorageAdapter = sqlite()) {
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  return { storage, notes, tags, templates }
}

async function write(notes: ReturnType<typeof setup>['notes'], id: string, text: string) {
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  const before = Y.encodeStateVector(doc)
  doc.getText(BODY).insert(0, text)
  await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
  await notes.flush()
}

describe('findBacklinks', () => {
  it('finds the live notes linking to a note, never the note itself or one in the Trash', async () => {
    const { storage, notes } = setup()
    const target = await notes.create('Target')
    const linking = await notes.create('Linking')
    const trashed = await notes.create('Trashed')
    await notes.create('Unrelated')
    await write(notes, linking, `See ${noteLink('Target', target)}.`)
    await write(notes, trashed, noteLink('Target', target))
    await write(notes, target, `Myself: ${noteLink('Target', target)}`)
    await notes.trash(trashed)

    const found = await findBacklinks(storage, target)
    expect(found.map((n) => n.title)).toEqual(['Linking'])
    expect((await notes.backlinks(target)).map((n) => n.id)).toEqual([linking])
  })

  it('leaves out a template that links to the note', async () => {
    const { storage, notes, templates } = setup()
    const target = await notes.create('Target')
    const linking = await notes.create('Linking')
    const template = await templates.create('Weekly review')
    await write(notes, linking, noteLink('Target', target))
    await write(notes, template, `Carry over ${noteLink('Target', target)}`)

    expect((await findBacklinks(storage, target)).map((n) => n.id)).toEqual([linking])
    expect((await notes.backlinks(target)).map((n) => n.id)).toEqual([linking])
  })

  it('finds nothing for a note no other note links to', async () => {
    const { storage, notes } = setup()
    const id = await notes.create('Alone')
    expect(await findBacklinks(storage, id)).toEqual([])
  })

  it('reads the link index, never the search index', async () => {
    const { storage, notes } = setup()
    const target = await notes.create('Target')
    const linking = await notes.create('Linking')
    await write(notes, linking, noteLink('Target', target))
    const search = vi.spyOn(storage, 'searchNotes')
    expect((await findBacklinks(storage, target)).map((n) => n.id)).toEqual([linking])
    expect(search).not.toHaveBeenCalled()
  })
})

const id = (i: number) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`

function stored(i: number, bodyMd: string, more: Partial<NoteRecord> = {}): NoteRecord {
  const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'test' })
  return {
    id: id(i),
    title: `Note ${i}`,
    titleHlc: hlc,
    bodyMd,
    ydoc: new Uint8Array([0]),
    bodyVersion: 0,
    bookId: null,
    bookHlc: hlc,
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: i,
    updatedAt: i,
    deletedAt: null,
    deletedHlc: null,
    ...more,
  }
}

describe('listBacklinks', () => {
  async function scenario(storage: StorageAdapter) {
    const target = id(0)
    const link = noteLink('Target', target)
    const notes = [
      stored(0, `Myself ${link}`),
      stored(1, link, { updatedAt: 50 }),
      stored(2, link, { updatedAt: 70 }),
      stored(3, `${link} twice ${link}`, { updatedAt: 70 }),
      stored(4, link, { bookId: TEMPLATES_BOOK_ID }),
      stored(5, link, { deletedAt: 9, deletedHlc: formatHlc({ wall: 9, counter: 0, node: 't' }) }),
      stored(6, `Unrelated ${noteLink('Other', id(99))}`),
      stored(7, `A longer ID devot://note/${target}0`),
      stored(8, `Title only`, { title: `devot://note/${target}` }),
    ]
    for (const note of notes) await storage.putNote(note)
    return {
      all: (await storage.listBacklinks(target, TEMPLATES_BOOK_ID, MAX_BACKLINKS)).map((n) => n.id),
      capped: (await storage.listBacklinks(target, TEMPLATES_BOOK_ID, 2)).map((n) => n.id),
      summary: (await storage.listBacklinks(target, TEMPLATES_BOOK_ID, 1))[0],
    }
  }

  it('lists live linking notes outside the notebook, newest first, then by ID, up to the limit', async () => {
    const { all, capped, summary } = await scenario(sqlite())
    expect(all).toEqual([id(3), id(2), id(1)])
    expect(capped).toEqual([id(3), id(2)])
    expect(summary).toEqual({
      id: id(3),
      title: 'Note 3',
      createdAt: 3,
      updatedAt: 70,
      bodyVersion: 1,
      bookId: null,
      status: 'none',
      pinned: false,
      tagIds: [],
    })
  })

  it('answers the same from the UI tests’ memory adapter', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    expect(await scenario(memoryStorage)).toEqual(await scenario(sqlite()))
  })
})

describe('linkTargets', () => {
  it('gives each live target its title, status, task progress and tags', async () => {
    const { notes, tags } = setup()
    const target = await notes.create('Plan')
    const gone = await notes.create('Gone')
    await write(notes, target, '- [x] one\n- [ ] two')
    await notes.setStatus(target, 'active')
    await tags.addToNote(target, 'work')
    await notes.trash(gone)

    expect(await notes.linkTargets([target, gone])).toEqual({
      [target]: {
        title: 'Plan',
        status: 'active',
        tasks: { done: 1, total: 2 },
        tags: [{ name: 'work', color: null }],
      },
    })
  })

  it('gives an embedded target its body without front matter, and only an embedded one', async () => {
    const { notes } = setup()
    const shown = await notes.create('Shown')
    const linked = await notes.create('Linked')
    await write(notes, shown, '---\ntags: [a]\n---\nThe body')
    await write(notes, linked, 'Other body')

    const found = await notes.linkTargets([shown, linked], [shown])
    expect(found[shown]?.embed).toEqual({ markdown: 'The body', clipped: false })
    expect(found[linked]).not.toHaveProperty('embed')
  })

  it('reads stored targets in batches of bodies, not one full record each', async () => {
    const { storage, notes } = setup()
    const target = await notes.create('Plan')
    await write(notes, target, '- [ ] one\n- [ ] two')
    await notes.release(target)
    const getNote = vi.spyOn(storage, 'getNote')
    const getBodies = vi.spyOn(storage, 'getBodies')

    expect(await notes.linkTargets([target])).toEqual({
      [target]: {
        title: 'Plan',
        status: 'none',
        tasks: { done: 0, total: 2 },
        tags: [],
      },
    })
    expect(getBodies).toHaveBeenCalled()
    expect(getNote).not.toHaveBeenCalled()
  })
})
