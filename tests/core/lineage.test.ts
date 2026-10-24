// Every write to a note body keeps the note's Yjs lineage (ADR 0002, risk 1): two devices holding the same note each write to it through one
// path, and merging both states shows each change once, where it was made. A write that rebuilt the document from text, or replaced more
// than it changed, would duplicate the other device's text or move it.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyBatch,
  BODY,
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  duplicateNote,
  importMarkdown,
  runHttpApiCall,
  seedWelcome,
  textLength,
  type ImportKind,
  type WelcomeContent,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const BASE = 'Groceries\n\nMilk and eggs.\n\nCall the bank.\n\nWater the plants.\n'

type Edit = readonly [from: string, to: string]
/** What the other device types: a word in the middle paragraph replaced. */
const ELSEWHERE: Edit[] = [['bank', 'dentist']]
/** What the path under test writes: the first and the last paragraph, the middle left as it is. */
const ENDS: Edit[] = [
  ['Groceries', 'Shopping'],
  ['plants', 'ferns'],
]
const edited = (text: string, edits: readonly Edit[]) =>
  edits.reduce((out, [from, to]) => out.replace(from, to), text)
const typedElsewhere = (text: string) => edited(text, ELSEWHERE)
const ends = (text: string) => edited(text, ENDS)

type Device = ReturnType<typeof device>

function device(node: string) {
  const storage = openSqliteAdapter(join(tempDir('devot-lineage-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock(node)
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({
    storage,
    notes,
    books,
    tags,
    clock,
    newId,
  })
  return { node, storage, clock, newId, notes, books, tags, templates }
}

/** Sync's first download: `to` gets the note as `from` stored it, so both hold one lineage. */
async function share(from: Device, to: Device, id: string) {
  await from.notes.flush()
  const record = await from.storage.getNote(id, { trashed: true })
  if (!record) throw new Error(`E_TEST_NO_NOTE ${id}`)
  await to.storage.putNote({
    ...record,
    bookId: null,
    bookHlc: '',
    bodyVersion: 0,
  })
}

async function noteWith(d: Device, body: string) {
  const id = await d.notes.create('Plan')
  await d.notes.setBody(id, body)
  await d.notes.flush()
  return id
}

/** Types in the editor: each edit is a change of its own in a replica of the note, which hands its updates to the core, as NoteEditor does. */
async function type(d: Device, id: string, edits: readonly Edit[]) {
  const replica = new Y.Doc()
  Y.applyUpdate(replica, (await d.notes.open(id)).state)
  const text = replica.getText(BODY)
  const updates: Uint8Array[] = []
  replica.on('update', (update: Uint8Array) => updates.push(update))
  for (const [from, to] of edits) {
    const at = text.toString().indexOf(from)
    if (at < 0) throw new Error('E_TEST_NO_TEXT')
    replica.transact(() => {
      text.delete(at, from.length)
      text.insert(at, to)
    })
  }
  for (const update of updates) await d.notes.applyUpdate(id, update)
  await d.notes.flush()
}

const stateOf = async (d: Device, id: string) => {
  await d.notes.flush()
  const record = await d.storage.getNote(id, { trashed: true })
  if (!record) throw new Error(`E_TEST_NO_NOTE ${id}`)
  return record.ydoc
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

/** Merges both devices' states in either order; they must agree. */
async function merged(a: Device, b: Device, id: string) {
  const [one, two] = [await stateOf(a, id), await stateOf(b, id)]
  const text = textOf(Y.mergeUpdates([one, two]))
  expect(textOf(Y.mergeUpdates([two, one]))).toBe(text)
  return text
}

/** A note on device a, shared with device b, where b's editor changes the middle paragraph. */
async function sharedNote(body = BASE) {
  const a = device('a1')
  const b = device('b1')
  const id = await noteWith(a, body)
  await share(a, b, id)
  await type(b, id, ELSEWHERE)
  return { a, b, id }
}

async function aiOn(d: Device, id: string) {
  const bookId = await d.books.create('Shared', null, { aiAccess: true })
  await d.notes.setBook(id, bookId)
  await d.notes.flush()
  await d.notes.release(id)
  return createAiService({
    storage: d.storage,
    clock: createClock(`${d.node}mcp`),
    newId: createIdGenerator(),
    atomically: d.storage.atomically,
  })
}

describe('a note written on two devices merges with each change once', () => {
  it('editor typing on both', async () => {
    const { a, b, id } = await sharedNote()
    await type(a, id, ENDS)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('setBody with the whole new text (MCP update_note markdown, AI writes)', async () => {
    const { a, b, id } = await sharedNote()
    const ai = await aiOn(a, id)
    await ai.update({ id, body: { markdown: ends(BASE) } })
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('MCP update_note patches', async () => {
    const { a, b, id } = await sharedNote()
    const ai = await aiOn(a, id)
    await ai.update({
      id,
      body: {
        patches: [
          { find: 'Groceries', replace: 'Shopping' },
          { find: 'Water the plants.', replace: 'Water the ferns.' },
        ],
      },
    })
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('a note MCP create_note made', async () => {
    const a = device('a1')
    const b = device('b1')
    const ai = createAiService({
      storage: a.storage,
      clock: createClock('a1mcp'),
      newId: createIdGenerator(),
      atomically: a.storage.atomically,
    })
    await a.books.create('Shared', null, { aiAccess: true })
    const { id } = await ai.create({
      title: 'Plan',
      markdown: BASE,
      notebook: 'Shared',
    })
    await share(a, b, id)
    await type(b, id, ELSEWHERE)
    await type(a, id, ENDS)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('the local HTTP API (notes.update through the app core, its editor typing meanwhile)', async () => {
    const { a, b, id } = await sharedNote()
    const bookId = await a.books.create('Shared', null, { aiAccess: true })
    await a.notes.setBook(id, bookId)
    await a.notes.flush()
    const {
      searchNotesInBooks: _search,
      countNotesInBooks: _count,
      noteTags: _noteTags,
      tagsInBooks: _tags,
      ...appStorage
    } = a.storage
    const api = createAiService({ storage: appStorage, clock: a.clock, newId: a.newId })
    const replica = new Y.Doc()
    Y.applyUpdate(replica, (await a.notes.open(id)).state)
    const updates: Uint8Array[] = []
    replica.on('update', (update: Uint8Array) => updates.push(update))
    const text = replica.getText(BODY)
    text.delete(0, 'Groceries'.length)
    text.insert(0, 'Shopping')
    for (const update of updates) await a.notes.applyUpdate(id, update)
    await runHttpApiCall(api, {
      op: 'notes.update',
      note: id,
      args: { patches: [{ find: 'Water the plants.', replace: 'Water the ferns.' }] },
    })
    await a.notes.mergeStored()
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('restoring a version', async () => {
    const a = device('a1')
    const b = device('b1')
    const id = await a.notes.create('Plan')
    await a.notes.setBody(id, ends(BASE))
    await a.notes.flush({ versions: true })
    await a.notes.setBody(id, BASE)
    await a.notes.flush({ versions: true })
    await share(a, b, id)
    await type(b, id, ELSEWHERE)
    const old = (await a.notes.history(id)).find(
      (e) => e.kind === 'body' && e.length === textLength(ends(BASE)),
    )!
    await a.notes.restoreRevision(id, old.id)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('a template applied to the note', async () => {
    const { a, b, id } = await sharedNote()
    const template = await a.templates.create('Checklist')
    await a.notes.setBody(template, '- [ ] Pack\n')
    await a.templates.applyTo(template, id, { now: 0 })
    expect(await merged(a, b, id)).toBe(`${typedElsewhere(BASE)}\n- [ ] Pack\n`)
  })

  it('a template saved from its editor', async () => {
    const a = device('a1')
    const b = device('b1')
    const id = await a.templates.create('Plan')
    await a.notes.setBody(id, BASE)
    await share(a, b, id)
    await type(b, id, ELSEWHERE)
    await a.templates.save(id, { body: ends(BASE) })
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('a note made from a template', async () => {
    const a = device('a1')
    const b = device('b1')
    const template = await a.templates.create('Plan')
    await a.notes.setBody(template, BASE)
    const id = await a.templates.apply(template, { now: 0 }, null)
    await share(a, b, id)
    await type(b, id, ELSEWHERE)
    await type(a, id, ENDS)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('an image link put in after its editor closed (insertAt)', async () => {
    const { a, b, id } = await sharedNote()
    await a.notes.insertAt(id, null, '![](devot://file/x)\n')
    await a.notes.flush()
    expect(await merged(a, b, id)).toBe(`${typedElsewhere(BASE)}![](devot://file/x)\n`)
  })

  it('a duplicate, and its source', async () => {
    const a = device('a1')
    const b = device('b1')
    const source = await noteWith(a, BASE)
    await share(a, b, source)
    const copy = await duplicateNote({ notes: a.notes, tags: a.tags }, source, {
      suffix: 'copy',
    })
    await share(a, b, copy)
    await type(b, copy, ELSEWHERE)
    await type(a, copy, ENDS)
    expect(await merged(a, b, copy)).toBe(ends(typedElsewhere(BASE)))
    await type(b, source, ELSEWHERE)
    expect(await merged(a, b, source)).toBe(typedElsewhere(BASE))
  })

  it('a note made from a selection (extract)', async () => {
    const a = device('a1')
    const b = device('b1')
    const source = await noteWith(a, 'Intro\n')
    const { id } = await a.notes.extract(source, BASE)
    await share(a, b, id)
    await type(b, id, ELSEWHERE)
    await type(a, id, ENDS)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('a batch change to a note not in memory', async () => {
    const { a, b, id } = await sharedNote()
    await a.notes.release(id)
    const result = await applyBatch({ notes: a.notes, tags: a.tags }, [id], {
      kind: 'status',
      status: 'active',
    })
    expect(result.changed).toEqual([id])
    expect(await merged(a, b, id)).toBe(typedElsewhere(BASE))
  })

  it('moving to the Trash and restoring', async () => {
    const { a, b, id } = await sharedNote()
    await a.notes.trash(id)
    await a.notes.restore(id)
    expect(await merged(a, b, id)).toBe(typedElsewhere(BASE))
  })

  it.each<[string, ImportKind, Record<string, string>]>([
    ['a Markdown file', 'files', { 'Notes/Plan.md': BASE }],
    ['a Markdown folder', 'folder', { 'Plan.md': BASE, 'Sub/Other.md': 'Other\n' }],
    [
      'an HTML file',
      'files',
      {
        'Notes/Plan.html': `<p>${BASE.trim().split('\n\n').join('</p><p>')}</p>`,
      },
    ],
  ])('a note imported from %s', async (_, kind, files) => {
    const a = device('a1')
    const b = device('b1')
    const [path] = Object.keys(files)
    const report = await importMarkdown({
      notes: a.notes,
      books: a.books,
      tags: a.tags,
      newId: a.newId,
      scan: {
        id: 1,
        name: 'Notes',
        kind,
        files: Object.entries(files).map(([p, text]) => ({
          path: p,
          bytes: text.length,
        })),
        images: [],
        skipped: [],
      },
      source: { read: async (p) => files[p]!, attach: async () => {} },
    })
    const id = report.noteIds[path!]!
    expect((await a.notes.read(id)).bodyMd).toBe(BASE)
    await share(a, b, id)
    await type(b, id, ELSEWHERE)
    await type(a, id, ENDS)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })
})

describe('first-launch notes', () => {
  const content: WelcomeContent = {
    bookName: 'Getting started',
    notes: [
      {
        id: '00000000-0000-7000-8000-0000000000a1',
        title: 'Welcome',
        body: BASE,
      },
    ],
  }
  const seed = (d: Device, given = content) =>
    seedWelcome({
      storage: d.storage,
      clock: d.clock,
      newId: d.newId,
      content: given,
    })

  it('seeded on two devices merge into one note', async () => {
    const a = device('a1')
    const b = device('b1')
    const id = (await seed(a))!
    await seed(b)
    expect(await merged(a, b, id)).toBe(BASE)
    await type(b, id, ELSEWHERE)
    await type(a, id, ENDS)
    expect(await merged(a, b, id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('take later edits under a client of the device, not the seed', async () => {
    const a = device('a1')
    const b = device('b1')
    const [first] = content.notes
    for (const d of [a, b]) await d.notes.seed(first!.id, first!.title, null, BASE)
    await a.notes.setBody(first!.id, ends(BASE))
    await b.notes.setBody(first!.id, typedElsewhere(BASE))
    expect(await merged(a, b, first!.id)).toBe(ends(typedElsewhere(BASE)))
  })

  it('seeded from another text keep each text whole', async () => {
    const a = device('a1')
    const b = device('b1')
    const id = (await seed(a))!
    const other = 'Hello\n'
    await seed(b, {
      ...content,
      notes: [{ ...content.notes[0]!, body: other }],
    })
    expect([BASE + other, other + BASE]).toContain(await merged(a, b, id))
  })
})
