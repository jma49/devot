import fc from 'fast-check'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  MAX_TITLE_CHARS,
  UUID_V7,
  type NoteService,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function freshPath() {
  return join(tempDir('devot-notes-'), 'devot.sqlite')
}

function service(path: string, node = 'mac1'): { notes: NoteService; storage: SqliteAdapter } {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock(node),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  return { notes, storage }
}

/** An editor replica that forwards its edits to the service, like the UI does. */
async function editorFor(notes: NoteService, id: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state, 'remote')
  const pending: Promise<void>[] = []
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') pending.push(notes.applyUpdate(id, update))
  })
  return { text: doc.getText(BODY), settled: () => Promise.all(pending) }
}

describe('a note survives a restart', () => {
  it('keeps the title and every edit after the store is closed and reopened', async () => {
    const path = freshPath()
    const first = service(path)
    const id = await first.notes.create()
    expect(id).toMatch(UUID_V7)

    const editor = await editorFor(first.notes, id)
    editor.text.insert(0, '# Sync research\n\nBody in Y.Text.')
    editor.text.delete(2, 5)
    await editor.settled()
    await first.notes.setTitle(id, 'Sync research')
    await first.notes.flush()
    first.storage.close()
    open.length = 0

    const second = service(path)
    expect((await second.notes.list()).map((n) => n.title)).toEqual(['Sync research'])
    const reopened = await editorFor(second.notes, id)
    expect(reopened.text.toString()).toBe('# research\n\nBody in Y.Text.')
  })

  it('derives the Markdown snapshot from the Yjs document', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create('T')
    const editor = await editorFor(notes, id)
    editor.text.insert(0, 'hello **world**')
    await editor.settled()
    await notes.flush()
    const row = storage.db.prepare('SELECT body_md FROM notes WHERE id = ?').get(id) as {
      body_md: string
    }
    expect(row.body_md).toBe('hello **world**')
  })

  it('saves on its own after the debounce delay', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    editor.text.insert(0, 'autosaved')
    await editor.settled()
    await new Promise((r) => setTimeout(r, 50))
    expect((await storage.getNote(id))?.bodyMd).toBe('autosaved')
  })

  it('stamps every title write with a later HLC', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create('a')
    const before = (await storage.getNote(id))!.titleHlc
    await notes.setTitle(id, 'b')
    await notes.flush()
    expect((await storage.getNote(id))!.titleHlc > before).toBe(true)
  })

  it('hides tombstoned notes from list and open', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create('gone')
    const record = (await storage.getNote(id))!
    await storage.putNote({
      ...record,
      deletedAt: Date.now(),
      deletedHlc: '0001728000000000-0000-mac1',
    })
    const other = service(freshPath())
    expect(await other.notes.list()).toEqual([])
    expect(await notes.list()).toEqual([])
    await expect(service(freshPath()).notes.open(id)).rejects.toThrow('E_NOTE_NOT_FOUND')
  })

  it('reads the database the Rust app created at schema v1', async () => {
    const path = freshPath()
    copyFileSync(join(import.meta.dirname, '../../src-tauri/tests/fixtures/schema-v1.sqlite'), path)
    const { storage } = service(path)
    expect((await storage.listNotes()).map((n) => n.title)).toEqual(['Fixture note'])
  })

  it('any sequence of edits reads back identically after a restart', async () => {
    const edit = fc.oneof(
      fc.record({
        kind: fc.constant('insert' as const),
        at: fc.nat(),
        text: fc.string({ maxLength: 12 }),
      }),
      fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), length: fc.nat({ max: 8 }) }),
    )
    await fc.assert(
      fc.asyncProperty(fc.array(edit, { maxLength: 40 }), async (edits) => {
        const path = freshPath()
        const first = service(path)
        const id = await first.notes.create()
        const editor = await editorFor(first.notes, id)
        for (const e of edits) {
          const length = editor.text.length
          if (e.kind === 'insert') editor.text.insert(e.at % (length + 1), e.text)
          else if (length > 0) {
            const at = e.at % length
            editor.text.delete(at, Math.min(e.length, length - at))
          }
        }
        await editor.settled()
        await first.notes.flush()
        const expected = editor.text.toString()
        first.storage.close()

        const second = service(path)
        expect((await editorFor(second.notes, id)).text.toString()).toBe(expected)
        expect((await second.storage.getNote(id))!.bodyMd).toBe(expected)
      }),
      { numRuns: 40 },
    )
  })
})

describe('replacing a body', () => {
  it('applies the difference as Yjs operations, so concurrent edits merge', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create()
    const editor = await editorFor(notes, id)
    editor.text.insert(0, 'Hello world')
    await editor.settled()
    const base = (await notes.open(id)).state

    // A replica edits from the same base while the body is replaced.
    const replica = new Y.Doc()
    Y.applyUpdate(replica, base)
    replica.getText(BODY).insert(8, '!')
    await notes.setBody(id, 'Howdy world')
    await notes.applyUpdate(id, Y.encodeStateAsUpdate(replica))
    await notes.flush()

    // A whole-text rewrite would have moved the replica's edit out of place.
    expect((await storage.getNote(id))!.bodyMd).toBe('Howdy wo!rld')
  })

  it('does nothing when the body is already the same', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create()
    await notes.setBody(id, 'Same')
    await notes.flush()
    const before = (await storage.getNote(id))!
    await notes.setBody(id, 'Same')
    await notes.flush()
    expect((await storage.getNote(id))!.ydoc).toEqual(before.ydoc)
  })

  it('release saves pending changes and frees the note; open loads it again', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create()
    await notes.setBody(id, 'Kept')
    await notes.release(id)
    expect((await storage.getNote(id))!.bodyMd).toBe('Kept')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await notes.open(id)).state)
    expect(doc.getText(BODY).toString()).toBe('Kept')
    await notes.release('unknown')
  })
})

describe('titles', () => {
  it('are cut to MAX_TITLE_CHARS code points on one line, so saving goes on', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create()
    await notes.setTitle(id, 'x'.repeat(MAX_TITLE_CHARS + 1))
    await notes.setBody(id, 'typed after the long title')
    await notes.flush()
    expect(await storage.getNote(id)).toMatchObject({
      title: 'x'.repeat(MAX_TITLE_CHARS),
      bodyMd: 'typed after the long title',
    })
    // Counted as Rust counts characters; a surrogate pair is never split.
    const smile = '\u{1F600}'
    await notes.setTitle(id, `${smile.repeat(MAX_TITLE_CHARS - 1)}a${smile}`)
    await notes.flush()
    expect((await storage.getNote(id))?.title).toBe(`${smile.repeat(MAX_TITLE_CHARS - 1)}a`)
    // A title is one line.
    await notes.setTitle(id, 'two\nlines\r\nhere')
    await notes.flush()
    expect((await storage.getNote(id))?.title).toBe('two lines here')
    // A new note's title too.
    const made = await notes.create('y'.repeat(MAX_TITLE_CHARS + 50))
    expect((await storage.getNote(made))?.title).toBe('y'.repeat(MAX_TITLE_CHARS))
  })

  it('over the limit in storage do not stop the note from saving', async () => {
    const { notes, storage } = service(freshPath())
    const id = await notes.create('Short')
    await notes.release(id)
    // Stored past the limit (by an older build, say).
    const long = 'x'.repeat(MAX_TITLE_CHARS + 500)
    storage.db.prepare('UPDATE notes SET title = ? WHERE id = ?').run(long, id)
    await notes.setBody(id, 'typed later')
    await notes.flush()
    // The body is saved; the title stays as stored until it is renamed.
    expect(await storage.getNote(id)).toMatchObject({ title: long, bodyMd: 'typed later' })
    expect((await notes.history(id)).map((e) => e.kind)).not.toContain('title')
    await notes.setTitle(id, 'Renamed')
    await notes.flush()
    expect((await storage.getNote(id))?.title).toBe('Renamed')
  })
})
