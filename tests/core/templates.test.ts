// Note templates on real SQLite: templates are ordinary notes in a reserved
// notebook that every device knows by the same ID. They stay out of the
// library (All Notes, notebooks, search) and out of AI tools, and a note
// made from one takes its defaults from the template's front matter.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  TEMPLATES_BOOK_ID,
  UUID_V7,
  type BookRecord,
  type NoteService,
  type OffsetAt,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
const services: NoteService[] = []
afterEach(async () => {
  // Saves still waiting would land on a closed database.
  for (const notes of services.splice(0)) await notes.flush()
  open.splice(0).forEach((a) => a.close())
})

const freshPath = () => join(tempDir('devot-templates-'), 'devot.sqlite')

/** The app's services on a database file, with this device's clock. */
function device(path: string, node = 'mac1') {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock(node)
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  services.push(notes)
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  return { storage, clock, notes, books, tags, templates }
}

type Device = ReturnType<typeof device>

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7])
const FILE_ID = '0192a6f0-0000-7000-8000-00000000f001'
const FILE_LINK = /devot:\/\/file\/([0-9a-f-]{36})/g

/** The IDs of the images a body shows, in order. */
const shownFiles = (body: string) => [...body.matchAll(FILE_LINK)].map((m) => m[1] as string)

/** A stored attachment, or undefined. */
const storedFile = (d: Device, id: string) =>
  d.storage.db.prepare('SELECT note_id AS noteId, name, data FROM files WHERE id = ?').get(id) as
    | { noteId: string; name: string; data: Buffer }
    | undefined

const UTC: OffsetAt = () => 0
// Tuesday 2026-03-03 09:05 UTC.
const CLOCK = { now: Date.parse('2026-03-03T09:05:00Z'), offsetAt: UTC }

/** A template with a body, saved. */
async function template(d: Device, title: string, body: string) {
  const id = await d.templates.create(title)
  await d.notes.setBody(id, body)
  await d.notes.flush()
  return id
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

describe('the Templates notebook', () => {
  it('is made on first use, once, under the reserved ID', async () => {
    const d = device(freshPath())
    expect(TEMPLATES_BOOK_ID).toMatch(UUID_V7)
    expect(await d.storage.listBooks()).toEqual([])
    const first = await d.templates.create('First')
    const second = await d.templates.create('Second')
    const rows = await d.storage.listBooks()
    expect(rows.map((b) => [b.id, b.name, b.parentId, b.aiAccess])).toEqual([
      [TEMPLATES_BOOK_ID, 'Templates', null, false],
    ])
    expect((await d.templates.list()).map((n) => n.id).sort()).toEqual([first, second].sort())
    expect((await d.storage.getNote(first))?.bookId).toBe(TEMPLATES_BOOK_ID)
  })

  it('is one notebook when two devices make it', async () => {
    const path = freshPath()
    const mac = device(path, 'mac1')
    const ipad = device(path, 'ipad1')
    await mac.templates.create('From the Mac')
    // The iPad made its own before it saw the Mac's: the same ID, so its
    // copy merges into one row instead of making a second notebook.
    const ipadRow: BookRecord = {
      ...(await mac.storage.listBooks())[0]!,
      nameHlc: ipad.clock.tick(),
      parentHlc: ipad.clock.tick(),
      createdAt: 5,
      updatedAt: 5,
    }
    await mac.storage.putBook(ipadRow)
    await ipad.templates.create('From the iPad')
    expect((await mac.storage.listBooks()).map((b) => b.id)).toEqual([TEMPLATES_BOOK_ID])
    expect((await ipad.templates.list()).map((n) => n.title).sort()).toEqual([
      'From the Mac',
      'From the iPad',
    ])
  })

  it('stays out of the notebook list and cannot be renamed, moved, shared with AI or deleted', async () => {
    const d = device(freshPath())
    await d.templates.create('T')
    const work = await d.books.create('Work', null)
    expect((await d.books.list()).map((b) => b.id)).toEqual([work])
    for (const change of [
      () => d.books.rename(TEMPLATES_BOOK_ID, 'Mine'),
      () => d.books.move(TEMPLATES_BOOK_ID, work),
      () => d.books.move(work, TEMPLATES_BOOK_ID),
      () => d.books.create('Inside', TEMPLATES_BOOK_ID),
      () => d.books.place(work, TEMPLATES_BOOK_ID, 'after'),
      () => d.books.setAiAccess(TEMPLATES_BOOK_ID, true),
      () => d.books.remove(TEMPLATES_BOOK_ID),
    ]) {
      await expect(change()).rejects.toThrow('E_BOOK_NOT_FOUND')
    }
    // Keying old notebooks leaves it alone.
    await d.books.settleOrder()
    const row = (await d.storage.listBooks()).find((b) => b.id === TEMPLATES_BOOK_ID)
    expect(row).toMatchObject({ name: 'Templates', sortKey: '', aiAccess: false, deletedAt: null })
  })

  it('keeps working when another device deleted the notebook row', async () => {
    const d = device(freshPath())
    const kept = await template(d, 'Kept', 'kiwi')
    const row = (await d.storage.listBooks())[0]!
    await d.storage.putBook({ ...row, deletedAt: 1, deletedHlc: d.clock.tick() })
    expect(await d.storage.listBooks()).toEqual([])
    const made = await d.templates.create('After')
    expect((await d.templates.list()).map((n) => n.id).sort()).toEqual([kept, made].sort())
    expect((await d.notes.list()).map((n) => n.id)).toEqual([])
    const note = await d.templates.apply(kept, CLOCK, null)
    await d.notes.flush()
    expect((await d.storage.getNote(note))?.bodyMd).toBe('kiwi')
  })
})

describe('templates stay out of the library', () => {
  async function library() {
    const d = device(freshPath())
    const work = await d.books.create('Work', null)
    const plain = await d.notes.create('Plain kiwi', work)
    await d.notes.setBody(plain, 'A kiwi note.')
    const loose = await d.notes.create('Loose kiwi', null)
    await d.notes.setBody(loose, 'A kiwi in no notebook.')
    const tpl = await template(d, 'Template kiwi', 'A kiwi template.')
    await d.tags.addToNote(tpl, 'fruit')
    await d.tags.addToNote(plain, 'fruit')
    await d.notes.flush()
    return { d, work, plain, loose, tpl }
  }

  it('lists templates apart from notes', async () => {
    const { d, plain, loose, tpl } = await library()
    expect((await d.notes.list()).map((n) => n.id).sort()).toEqual([plain, loose].sort())
    expect((await d.templates.list()).map((n) => n.id)).toEqual([tpl])
    const both = await d.templates.listWithNotes()
    expect(both.notes).toEqual(await d.notes.list())
    expect(both.templates).toEqual(await d.templates.list())
  })

  it('never finds a template by search, with or without qualifiers', async () => {
    const { d, plain, loose, work } = await library()
    const ids = async (query: string, scope?: Parameters<typeof d.notes.search>[1]) =>
      (await d.notes.search(query, scope)).map((n) => n.id).sort()
    expect(await ids('kiwi')).toEqual([plain, loose].sort())
    expect(await ids('title:template')).toEqual([])
    expect(await ids('tag:fruit')).toEqual([plain])
    expect(await ids('book:Templates')).toEqual([])
    expect(await ids('kiwi -book:Work')).toEqual([loose])
    expect(await ids('kiwi', { bookId: work, filter: null })).toEqual([plain])
  })

  it('gives a duplicated template its own images and keeps it a template', async () => {
    const d = device(freshPath())
    const tpl = await d.templates.create('Shot')
    await d.storage.putFile({ id: FILE_ID, noteId: tpl, name: 'shot.png' }, PNG)
    await d.notes.setBody(tpl, `![](devot://file/${FILE_ID}#small)`)
    await d.notes.flush()
    const copy = await d.notes.duplicate(tpl)
    expect((await d.templates.list()).map((n) => n.id).sort()).toEqual([tpl, copy].sort())
    const [file] = shownFiles((await d.storage.getNote(copy))?.bodyMd ?? '')
    expect(file).not.toBe(FILE_ID)
    await d.notes.trash(tpl)
    await d.notes.purge(tpl)
    expect(storedFile(d, file as string)?.noteId).toBe(copy)
  })

  it('keeps a template a template through the Trash and a duplicate', async () => {
    const { d, tpl } = await library()
    await d.notes.trash(tpl)
    expect(await d.templates.list()).toEqual([])
    expect((await d.notes.listTrash()).map((n) => n.id)).toEqual([tpl])
    await d.notes.restore(tpl)
    const copy = await d.notes.duplicate(tpl)
    expect((await d.templates.list()).map((n) => n.id).sort()).toEqual([tpl, copy].sort())
    expect((await d.notes.list()).some((n) => n.id === copy)).toBe(false)
  })
})

describe('AI tools (devot-mcp) never see templates', () => {
  it('lists, finds and reads no template, even with AI access set on its notebook', async () => {
    const path = freshPath()
    const d = device(path)
    const shared = await d.books.create('Shared', null)
    await d.books.setAiAccess(shared, true)
    const visible = await d.notes.create('Visible kiwi', shared)
    await d.notes.setBody(visible, 'A kiwi.')
    const tpl = await template(d, 'Template kiwi', 'A kiwi template.')
    // An older Devot showed Templates as a plain notebook, where AI access
    // could be turned on.
    const row = (await d.storage.listBooks()).find((b) => b.id === TEMPLATES_BOOK_ID)!
    await d.storage.putBook({ ...row, aiAccess: true, aiAccessHlc: d.clock.tick() })
    await d.notes.flush()

    const mcp = openSqliteAdapter(path, { migrate: false })
    open.push(mcp)
    const ai = createAiService({
      storage: mcp,
      clock: createClock('mcptest'),
      newId: createIdGenerator(),
      atomically: mcp.atomically,
    })
    expect((await ai.notebooks()).map((b) => b.id)).toEqual([shared])
    expect((await ai.search('kiwi')).map((h) => h.id)).toEqual([visible])
    await expect(ai.read(tpl)).rejects.toThrow('E_NOTE_NOT_FOUND')
    await expect(
      ai.create({ title: 'x', markdown: 'y', notebook: TEMPLATES_BOOK_ID }),
    ).rejects.toThrow('E_BOOK_NOT_FOUND')
    await expect(ai.create({ title: 'x', markdown: 'y', notebook: 'Templates' })).rejects.toThrow(
      'E_BOOK_NOT_FOUND',
    )
  })
})

describe('a note from a template', () => {
  it('takes its title, notebook, tags and status from the front matter, which it drops', async () => {
    const d = device(freshPath())
    const work = await d.books.create('Work', null)
    const meetings = await d.books.create('Meetings', work)
    const tpl = await template(
      d,
      'Meeting',
      '---\ntitle: Meeting {{date}}\nnotebook: Work/Meetings\ntags: [meeting, Weekly]\n' +
        'status: on hold\nlang: en\n---\n# {{title}}\n\nAt {{time}} {{who}}\n',
    )
    const id = await d.templates.apply(tpl, CLOCK, null)
    await d.notes.flush()
    const note = (await d.notes.list()).find((n) => n.id === id)!
    expect(note).toMatchObject({ title: 'Meeting 2026-03-03', bookId: meetings, status: 'on_hold' })
    const tags = new Map((await d.tags.list()).map((t) => [t.id, t.name]))
    expect(note.tagIds.map((t) => tags.get(t)).sort()).toEqual(['Weekly', 'meeting'])
    const record = (await d.storage.getNote(id))!
    const body = '---\nlang: en\n---\n# Meeting 2026-03-03\n\nAt 09:05 {{who}}\n'
    expect(record.bodyMd).toBe(body)
    // The body went in as Yjs operations: the document holds the same text.
    expect(textOf(record.ydoc)).toBe(body)
    // The template is unchanged.
    expect((await d.storage.getNote(tpl))?.bodyMd).toContain('{{date}}')
    expect((await d.templates.list()).map((n) => n.id)).toEqual([tpl])
  })

  it('goes to the given notebook when the template names none, or one that does not exist', async () => {
    const d = device(freshPath())
    const work = await d.books.create('Work', null)
    const plain = await template(d, 'Plain', 'Body')
    const unknown = await template(d, 'Unknown', '---\nnotebook: Nowhere\n---\nBody')
    expect((await d.storage.getNote(await d.templates.apply(plain, CLOCK, work)))?.bookId).toBe(
      work,
    )
    expect((await d.storage.getNote(await d.templates.apply(unknown, CLOCK, work)))?.bookId).toBe(
      work,
    )
    expect(
      (await d.storage.getNote(await d.templates.apply(plain, CLOCK, null)))?.bookId,
    ).toBeNull()
    // The picker previews the same notebook.
    expect((await d.templates.draft(plain, CLOCK, work)).bookId).toBe(work)
    expect((await d.templates.draft(unknown, CLOCK, null)).bookId).toBeNull()
    // Never into Templates: a note made from a template is a note.
    const fromTemplates = await d.templates.apply(plain, CLOCK, TEMPLATES_BOOK_ID)
    expect((await d.storage.getNote(fromTemplates))?.bookId).toBeNull()
    const made = await d.templates.apply(plain, CLOCK, null)
    expect((await d.notes.list()).some((n) => n.id === made)).toBe(true)
  })

  it('uses the template as it is now, edits not yet saved included', async () => {
    const d = device(freshPath())
    const tpl = await template(d, 'Draft', 'Old')
    await d.notes.setBody(tpl, 'New {{date:YYYY}}')
    const id = await d.templates.apply(tpl, CLOCK, null)
    await d.notes.flush()
    expect((await d.storage.getNote(id))?.bodyMd).toBe('New 2026')
    expect(await d.templates.draft(tpl, CLOCK)).toMatchObject({ title: 'Draft', body: 'New 2026' })
  })

  it('keeps the code of a storage failure instead of calling it a missing template', async () => {
    const d = device(freshPath())
    const tpl = await template(d, 'T', 'Body')
    d.storage.close()
    await expect(d.templates.draft(tpl, CLOCK)).rejects.toThrow(/not open/)
    open.splice(open.indexOf(d.storage), 1)
    services.splice(services.indexOf(d.notes), 1)
  })

  it('owns copies of the images the template shows, so purging the template keeps them', async () => {
    const d = device(freshPath())
    const tpl = await d.templates.create('Shot')
    await d.storage.putFile({ id: FILE_ID, noteId: tpl, name: 'shot.png' }, PNG)
    await d.notes.setBody(tpl, `# {{title}}\n\n![shot](devot://file/${FILE_ID}#half)\n`)
    await d.notes.flush()

    const id = await d.templates.apply(tpl, CLOCK, null)
    await d.notes.flush()
    const body = (await d.storage.getNote(id))?.bodyMd ?? ''
    const [copy] = shownFiles(body)
    expect(copy).toMatch(UUID_V7)
    expect(copy).not.toBe(FILE_ID)
    // Only the ID changed: the size preset stays.
    expect(body).toBe(`# Shot\n\n![shot](devot://file/${copy}#half)\n`)
    // The template keeps its own image.
    expect(shownFiles((await d.storage.getNote(tpl))?.bodyMd ?? '')).toEqual([FILE_ID])

    await d.notes.trash(tpl)
    await d.notes.purge(tpl)
    expect(storedFile(d, FILE_ID)).toBeUndefined()
    const file = storedFile(d, copy as string)
    expect(file).toMatchObject({ noteId: id, name: 'shot.png' })
    expect(new Uint8Array(file?.data ?? [])).toEqual(PNG)
  })

  it("leaves no note behind when the template's images cannot be copied", async () => {
    const d = device(freshPath())
    const tpl = await d.templates.create('Shot')
    await d.storage.putFile({ id: FILE_ID, noteId: tpl, name: 'shot.png' }, PNG)
    await d.notes.setBody(tpl, `![](devot://file/${FILE_ID})`)
    await d.notes.flush()
    // A real failure inside the copy's write, on the real database.
    d.storage.db.exec(
      "CREATE TEMP TRIGGER no_copies BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'E_DISK_FULL'); END",
    )
    await expect(d.templates.apply(tpl, CLOCK, null)).rejects.toThrow('E_DISK_FULL')
    await d.notes.flush()
    expect(await d.notes.list()).toEqual([])
    expect(await d.notes.listTrash()).toEqual([])
    expect((await d.templates.list()).map((n) => n.id)).toEqual([tpl])
    expect(storedFile(d, FILE_ID)?.noteId).toBe(tpl)
  })

  it('is refused for a note that is not a template', async () => {
    const d = device(freshPath())
    const plain = await d.notes.create('Plain', null)
    await expect(d.templates.apply(plain, CLOCK, null)).rejects.toThrow('E_TEMPLATE_NOT_FOUND')
    await expect(d.templates.draft(plain, CLOCK)).rejects.toThrow('E_TEMPLATE_NOT_FOUND')
    await expect(d.templates.draft('nope', CLOCK)).rejects.toThrow('E_TEMPLATE_NOT_FOUND')
  })
})

describe('starter templates', () => {
  it('make a note without being stored, and cannot be written', async () => {
    const d = device(freshPath())
    const id = await d.templates.apply('starter:planning', CLOCK, null)
    expect((await d.notes.read(id)).title).toBe('Planning')
    expect((await d.notes.read(id)).bodyMd).not.toContain('!Instructions')
    // Nothing is stored for the starter: the Templates notebook stays empty.
    expect(await d.templates.list()).toEqual([])
    await expect(d.notes.setBody('starter:planning', 'x')).rejects.toThrow('E_NOTE_NOT_FOUND')
  })

  it('save an edit as a copy of the user, and leave the starter as it was', async () => {
    const d = device(freshPath())
    const copy = await d.templates.save('starter:debugging', { body: 'Mine {{date}}' })
    expect(copy.startsWith('starter:')).toBe(false)
    expect((await d.templates.list()).map((n) => n.id)).toEqual([copy])
    expect((await d.notes.read(copy)).title).toBe('Debugging')
    expect((await d.notes.read(copy)).bodyMd).toBe('Mine {{date}}')
    // A template of the user's own is written in place.
    expect(await d.templates.save(copy, { body: 'Again' })).toBe(copy)
    expect((await d.notes.read(copy)).bodyMd).toBe('Again')
    await expect(d.templates.save('starter:nope', { body: 'x' })).rejects.toThrow(
      'E_TEMPLATE_NOT_FOUND',
    )
  })
})

describe('applying a template to a note', () => {
  it("keeps the note's tags and status and adds the template's", async () => {
    const d = device(freshPath())
    const t = await template(d, 'T', '---\ntags: [b]\nstatus: Active\n---\nFrom template\n')
    const note = await d.notes.create('Mine', null)
    await d.notes.setBody(note, 'Own text')
    await d.notes.setStatus(note, 'completed')
    await d.tags.addToNote(note, 'a')
    await d.templates.applyTo(t, note, CLOCK)
    await d.notes.flush()
    const stored = (await d.storage.listNotes()).find((n) => n.id === note)
    expect(stored?.status).toBe('completed')
    const names = (await d.tags.list())
      .filter((tag) => stored?.tagIds.includes(tag.id))
      .map((tag) => tag.name)
      .sort()
    expect(names).toEqual(['a', 'b'])
    expect((await d.notes.read(note)).bodyMd).toBe('Own text\n\nFrom template\n')
  })

  it('fills an empty note: the template title, body, status and its own image copies', async () => {
    const d = device(freshPath())
    const t = await template(d, 'Daily', '---\nstatus: Active\n---\nPlan\n')
    await d.storage.putFile({ id: FILE_ID, noteId: t, name: 'shot.png' }, PNG)
    await d.notes.setBody(t, `---\nstatus: Active\n---\nPlan ![](devot://file/${FILE_ID})\n`)
    await d.notes.flush()
    const note = await d.notes.create('', null)
    await d.templates.applyTo(t, note, CLOCK)
    await d.notes.flush()
    const read = await d.notes.read(note)
    expect(read.title).toBe('Daily')
    expect(read.bodyMd.startsWith('Plan ![](devot://file/')).toBe(true)
    const [file] = shownFiles(read.bodyMd)
    expect(file).not.toBe(FILE_ID)
    expect(storedFile(d, file as string)?.noteId).toBe(note)
    expect((await d.storage.listNotes()).find((n) => n.id === note)?.status).toBe('active')
    // No second note is made.
    expect((await d.storage.listNotes()).filter((n) => n.id !== t).map((n) => n.id)).toEqual([note])
  })

  it('names a titled note in {{title}}, not the template', async () => {
    const d = device(freshPath())
    const t = await template(d, 'Brainstorming', '# {{title}}\n\nIdeas\n')
    const note = await d.notes.create('Q3 planning', null)
    await d.templates.applyTo(t, note, CLOCK)
    await d.notes.flush()
    const read = await d.notes.read(note)
    expect(read.title).toBe('Q3 planning')
    expect(read.bodyMd).toBe('# Q3 planning\n\nIdeas\n')
  })

  it('keeps text and a title typed while the fill runs', async () => {
    const d = device(freshPath())
    const t = await template(d, 'Daily', '# {{title}}\n\nPlan\n')
    const note = await d.notes.create('', null)
    // The user types between the fill's read and its write.
    const listNotes = d.storage.listNotes.bind(d.storage)
    let typed = false
    d.storage.listNotes = async (...args: Parameters<typeof listNotes>) => {
      if (!typed) {
        typed = true
        await d.notes.setBody(note, 'Typed')
        await d.notes.setTitle(note, 'Mine')
      }
      return listNotes(...args)
    }
    await d.templates.applyTo(t, note, CLOCK)
    await d.notes.flush()
    expect(typed).toBe(true)
    const read = await d.notes.read(note)
    expect(read.title).toBe('Mine')
    expect(read.bodyMd).toBe('Typed\n\n# Daily\n\nPlan\n')
  })
})
