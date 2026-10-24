// Two windows showing one note (a note window and the main window) each run a core holding a Yjs copy
// of it. Every change one core makes reaches the other's core and editor at once (relayed, see
// noteRelay.ts), and each window saves its own changes into the stored state, so neither overwrites the other.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { BODY, type NoteServiceOptions, type StorageAdapter } from '../../src/core'
import { windowsOn } from '../support/note-windows'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => {
  open.splice(0).forEach((a) => a.close())
  vi.restoreAllMocks()
})

function sqlite() {
  const storage = openSqliteAdapter(join(tempDir('devot-windows-'), 'devot.sqlite'))
  open.push(storage)
  return storage
}

async function twoWindows(
  body = 'Plan\n',
  storage: StorageAdapter = sqlite(),
  options: Partial<NoteServiceOptions> = {},
) {
  // Made by a window of its own, so both start from the note as stored.
  const [setup] = windowsOn(storage, ['setup']).windows
  const id = await setup!.notes.create('Plan')
  await setup!.notes.setBody(id, body)
  await setup!.notes.release(id)
  const app = windowsOn(storage, ['main', 'note'], options)
  const [main, note] = app.windows as [(typeof app.windows)[0], (typeof app.windows)[0]]
  return { ...app, main, note, id, storage }
}

const append = (editor: Y.Doc, text: string) => {
  const body = editor.getText(BODY)
  body.insert(body.length, text)
}

const stored = async (storage: StorageAdapter, id: string) =>
  (await storage.getNote(id, { trashed: true }))!

describe('two windows showing one note', () => {
  it('see each other’s typing at once, before either saves', async () => {
    const w = await twoWindows()
    const mainEditor = await w.show(w.main, w.id)
    const noteEditor = await w.show(w.note, w.id)
    await w.deliverAll()
    append(noteEditor, 'From the note window\n')
    await w.deliverAll()
    expect(w.editorText(w.main, w.id)).toBe('Plan\nFrom the note window\n')
    append(mainEditor, 'From the main window\n')
    await w.deliverAll()
    expect(w.editorText(w.note, w.id)).toBe('Plan\nFrom the note window\nFrom the main window\n')
    expect((await w.main.notes.read(w.id)).bodyMd).toBe(w.editorText(w.note, w.id))
    expect((await stored(w.storage, w.id)).bodyMd).toBe('Plan\n')
  })

  it('never send a relayed change back', async () => {
    const w = await twoWindows()
    await w.show(w.main, w.id)
    const noteEditor = await w.show(w.note, w.id)
    await w.deliverAll()
    append(noteEditor, 'x')
    await w.settle()
    expect(w.main.inbox.map((m) => m.kind)).toEqual(['update'])
    await w.deliver(w.main)
    expect(w.note.inbox).toEqual([])
  })

  it('give a window that reads the note in later the edits the other has not saved', async () => {
    const w = await twoWindows()
    const mainEditor = await w.show(w.main, w.id)
    append(mainEditor, 'Unsaved\n')
    await w.deliverAll()
    await w.show(w.note, w.id)
    expect(w.main.inbox.map((m) => m.kind)).toEqual(['want'])
    await w.deliverAll()
    expect(w.editorText(w.note, w.id)).toBe('Plan\nUnsaved\n')
  })

  it('take a change that arrives while the note is being read in, once it is', async () => {
    const storage = sqlite()
    const w = await twoWindows('Plan\n', storage)
    const mainEditor = await w.show(w.main, w.id)
    w.note.inbox.length = 0
    let release = () => {}
    const reading = new Promise<void>((resolve) => (release = resolve))
    const getNote = storage.getNote.bind(storage)
    vi.spyOn(storage, 'getNote').mockImplementation(async (...args) => {
      await reading
      return getNote(...args)
    })
    const opening = w.note.notes.open(w.id)
    append(mainEditor, 'Typed meanwhile\n')
    await w.settle()
    const receiving = w.note.notes.receive(w.note.inbox.shift()!)
    release()
    await Promise.all([opening, receiving])
    expect((await w.note.notes.read(w.id)).bodyMd).toBe('Plan\nTyped meanwhile\n')
  })

  it('keep both windows’ edits when both type and save at the same time', async () => {
    const w = await twoWindows('Plan\n')
    const mainEditor = await w.show(w.main, w.id)
    const noteEditor = await w.show(w.note, w.id)
    await w.deliverAll()
    append(mainEditor, 'main ')
    append(noteEditor, 'note ')
    await w.settle()
    await Promise.all([w.main.notes.flush(), w.note.notes.flush()])
    const body = (await stored(w.storage, w.id)).bodyMd
    expect(body).toContain('main ')
    expect(body).toContain('note ')
    await w.deliverAll()
    expect(w.editorText(w.main, w.id)).toBe(body)
    expect(w.editorText(w.note, w.id)).toBe(body)
  })

  it('leave saving a change to the window that made it', async () => {
    const w = await twoWindows()
    await w.show(w.main, w.id)
    const noteEditor = await w.show(w.note, w.id)
    await w.deliverAll()
    append(noteEditor, 'Typed in the note window\n')
    await w.deliverAll()
    const before = (await stored(w.storage, w.id)).bodyVersion
    await w.main.notes.flush()
    expect((await stored(w.storage, w.id)).bodyVersion).toBe(before)
    await w.note.notes.flush()
    expect((await stored(w.storage, w.id)).bodyMd).toBe('Plan\nTyped in the note window\n')
  })

  it('tell the other windows of each write, with its date', async () => {
    const w = await twoWindows()
    const noteEditor = await w.show(w.note, w.id)
    await w.deliverAll()
    append(noteEditor, 'x')
    await w.settle()
    w.main.inbox.length = 0
    await w.note.notes.flush()
    const record = await stored(w.storage, w.id)
    expect(w.main.inbox).toEqual([{ kind: 'saved', noteId: w.id, updatedAt: record.updatedAt }])
  })

  it('take the newer of two titles, whichever arrives last', async () => {
    const w = await twoWindows()
    await w.show(w.main, w.id)
    await w.show(w.note, w.id)
    await w.deliverAll()
    await w.note.notes.setTitle(w.id, 'Older')
    // A later time: the older title reaches the main window after its own.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await w.main.notes.setTitle(w.id, 'Newer')
    await w.deliverAll()
    expect(await w.main.notes.title(w.id)).toBe('Newer')
    expect(await w.note.notes.title(w.id)).toBe('Newer')
    expect(w.note.titles.get(w.id)).toBe('Newer')
    expect(w.main.titles.has(w.id)).toBe(false)
  })

  it('save a relayed title only from the window that set it', async () => {
    const w = await twoWindows()
    await w.show(w.main, w.id)
    await w.show(w.note, w.id)
    await w.deliverAll()
    await w.note.notes.setTitle(w.id, 'Renamed')
    await w.deliverAll()
    const before = (await stored(w.storage, w.id)).bodyVersion
    await w.main.notes.flush()
    expect((await stored(w.storage, w.id)).bodyVersion).toBe(before)
    await w.note.notes.flush()
    expect((await stored(w.storage, w.id)).title).toBe('Renamed')
  })

  it('keep the note’s first text as a version once, in the window that changed it', async () => {
    const w = await twoWindows('Start\n')
    const mainEditor = await w.show(w.main, w.id)
    const noteEditor = await w.show(w.note, w.id)
    await w.deliverAll()
    append(noteEditor, 'note\n')
    await w.deliverAll()
    append(mainEditor, 'main\n')
    await w.deliverAll()
    await Promise.all([w.main.notes.flush(), w.note.notes.flush()])
    await w.main.notes.history(w.id)
    await w.note.notes.history(w.id)
    const bodies = (await w.storage.listRevisions(w.id)).filter((r) => r.kind === 'body')
    expect(bodies).toHaveLength(1)
    const kept = await w.storage.getRevision(bodies[0]!.id)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, kept!.ydoc!)
    expect(doc.getText(BODY).toString()).toBe('Start\n')
  })

  it('ignore a change to a note the window does not hold, and a relayed update it cannot read', async () => {
    const w = await twoWindows()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await w.note.notes.receive({
      kind: 'update',
      noteId: w.id,
      data: Uint8Array.of(1, 2, 3),
    })
    expect(warn).not.toHaveBeenCalled()
    await w.show(w.note, w.id)
    await w.note.notes.receive({
      kind: 'update',
      noteId: w.id,
      data: Uint8Array.of(9, 9, 9),
    })
    expect(warn).toHaveBeenCalledWith('W_NOTE_RELAY_INVALID', w.id)
    expect((await w.note.notes.read(w.id)).bodyMd).toBe('Plan\n')
  })
})
