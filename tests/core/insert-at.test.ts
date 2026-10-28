import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function services(saveDelayMs = 5) {
  const storage = openSqliteAdapter(join(tempDir('devot-insert-at-'), 'devot.sqlite'))
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    saveDelayMs,
  })
  return { storage, notes }
}

async function replicaOf(notes: ReturnType<typeof services>['notes'], id: string) {
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  return { doc, text: doc.getText(BODY) }
}

const anchorAt = (text: Y.Text, index: number) =>
  Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, -1))

describe('inserting text at a position the editor remembered', () => {
  it('puts it where the position is now, after edits made since', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Note')
    await notes.setBody(id, 'Hello world')
    const { text } = await replicaOf(notes, id)
    const anchor = anchorAt(text, 6)

    // Text typed before it moves it; text typed at it stays after it.
    await notes.setBody(id, 'Top: Hello world')
    await notes.insertAt(id, anchor, '![shot](devot://file/x)')
    await notes.flush()
    expect((await storage.getNote(id))?.bodyMd).toBe('Top: Hello ![shot](devot://file/x)world')
  })

  it('keeps text typed at the position after the insertion', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Note')
    await notes.setBody(id, 'ab')
    const { text } = await replicaOf(notes, id)
    const anchor = anchorAt(text, 1)
    await notes.setBody(id, 'aXb')
    await notes.insertAt(id, anchor, 'LINK')
    await notes.flush()
    expect((await storage.getNote(id))?.bodyMd).toBe('aLINKXb')
  })

  it('goes to the end when the position is unknown', async () => {
    const { notes, storage } = services()
    const id = await notes.create('Note')
    await notes.setBody(id, 'Body')
    await notes.insertAt(id, null, '!')
    await notes.insertAt(id, new Uint8Array([255, 255, 255]), '?')
    await notes.flush()
    expect((await storage.getNote(id))?.bodyMd).toBe('Body!?')
  })

  it('is saved and reaches an editor that opens the note afterwards', async () => {
    const { notes } = services()
    const id = await notes.create('Note')
    await notes.insertAt(id, null, 'late link')
    const { text } = await replicaOf(notes, id)
    expect(text.toString()).toBe('late link')
    await notes.flush()
  })

  it('refuses a note that is gone', async () => {
    const { notes } = services()
    const id = await notes.create('Note')
    await notes.trash(id)
    await expect(notes.insertAt(id, null, 'x')).rejects.toThrow('E_NOTE_NOT_FOUND')
    await expect(notes.insertAt('0192a6f0-0000-7000-8000-00000000ffff', null, 'x')).rejects.toThrow(
      'E_NOTE_NOT_FOUND',
    )
  })
})

describe('lookups for the link popup', () => {
  it('search saves pending edits first, unless told not to', async () => {
    const { notes, storage } = services(60_000)
    const id = await notes.create('Findable')
    await notes.setBody(id, 'draft words')
    // Waiting for its save: storage still holds the empty body.
    expect((await storage.getNote(id))?.bodyMd).toBe('')

    expect((await notes.search('Findable', undefined, { flush: false })).found).toHaveLength(1)
    expect((await storage.getNote(id))?.bodyMd).toBe('')

    await notes.search('Findable')
    expect((await storage.getNote(id))?.bodyMd).toBe('draft words')
    await notes.flush()
  })

  it('list can stop at a limit', async () => {
    const { notes } = services()
    for (const title of ['a', 'b', 'c']) await notes.create(title)
    expect(await notes.list()).toHaveLength(3)
    expect(await notes.list(2)).toHaveLength(2)
  })
})
