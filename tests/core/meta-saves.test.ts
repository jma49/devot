// A save that changed no text writes the note's fields alone: the body and its Yjs state, which
// can take several MiB, stay as stored, and the result is the same as a whole write.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  createBookService,
  createNoteService,
  newWriter,
  WRITES,
  type StorageAdapter,
} from '../../src/core'
import { createClock } from '../../src/core/hlc'
import { createIdGenerator } from '../../src/core/ids'
import { observeWrites } from '../../src/core/observeWrites'
import { tempSqliteAdapter } from '../support/sqlite-adapter'

function watched(change: (storage: StorageAdapter) => Partial<StorageAdapter> = () => ({})) {
  const sqlite = tempSqliteAdapter('devot-meta-saves-')
  const writes: string[] = []
  const observed: (readonly string[] | undefined)[] = []
  const base: StorageAdapter = {
    ...sqlite,
    async putNote(note) {
      writes.push('note')
      await sqlite.putNote(note)
    },
    async putNoteMeta(note) {
      writes.push('meta')
      await sqlite.putNoteMeta(note)
    },
  }
  const storage = observeWrites({ ...base, ...change(base) }, (ids) => observed.push(ids))
  const service = (node = 'mac1') =>
    createNoteService({ storage, clock: createClock(node), newId: createIdGenerator() })
  const book = () =>
    createBookService({ storage, clock: createClock('mac1'), newId: createIdGenerator() }).create(
      'Work',
      null,
    )
  return { sqlite, writes, observed, service, book }
}

describe('saves that change only a note’s fields', () => {
  it('write a title, status, pin or notebook change without the body', async () => {
    const { sqlite, writes, observed, service, book } = watched()
    const BOOK = await book()
    const notes = service()
    const id = await notes.create('Plan')
    await notes.setBody(id, 'See [the other](devot://note/0192a6f0-0000-7000-8000-000000000002)')
    await notes.flush()
    const body = await sqlite.getNote(id)
    writes.length = 0
    observed.length = 0

    await notes.setTitle(id, 'Renamed')
    await notes.flush()
    await notes.setStatus(id, 'active')
    await notes.setPinned(id, true)
    await notes.flush()
    await notes.setBook(id, BOOK)
    await notes.flush()
    expect(writes).toEqual(['meta', 'meta', 'meta'])
    // The mirror and sync hear of each, as of a whole write.
    expect(observed).toEqual([[id], [id], [id]])

    const stored = await sqlite.getNote(id)
    expect(stored).toMatchObject({
      title: 'Renamed',
      status: 'active',
      pinned: true,
      bookId: BOOK,
      bodyMd: body?.bodyMd,
      bodyVersion: (body?.bodyVersion ?? 0) + 3,
    })
    expect(Buffer.from(stored!.ydoc).equals(Buffer.from(body!.ydoc))).toBe(true)
    expect(
      (
        await sqlite.listBacklinks(
          '0192a6f0-0000-7000-8000-000000000002',
          '0192a6f0-0000-7000-9000-0000000000ff',
          10,
        )
      ).map((n) => n.id),
    ).toEqual([id])
    expect((await sqlite.listRevisions(id)).some((r) => r.kind === 'title')).toBe(true)

    await notes.setBody(id, 'Changed')
    await notes.setTitle(id, 'Again')
    await notes.flush()
    expect(writes.at(-1)).toBe('note')
    expect((await sqlite.getNote(id))?.bodyMd).toBe('Changed')
  })

  it('write the whole note after another process wrote it, so nothing either wrote is lost', async () => {
    const { sqlite, writes, service } = watched()
    const here = service('mac1')
    const id = await here.create('Plan')
    await here.setBody(id, 'Ours')
    await here.flush()
    const there = service('mac2')
    await there.open(id)
    await there.setBody(id, 'Ours and theirs')
    await there.flush()
    writes.length = 0

    await here.setTitle(id, 'Renamed')
    await here.flush()
    expect(writes).toEqual(['meta', 'note'])
    expect(await sqlite.getNote(id)).toMatchObject({
      title: 'Renamed',
      bodyMd: 'Ours and theirs',
    })
  })

  it('write the fields alone after taking in a stored copy that holds the whole document', async () => {
    const { sqlite, writes, service } = watched()
    const here = service('mac1')
    const id = await here.create('Plan')
    await here.setBody(id, 'Ours')
    await here.flush()
    const there = service('mac2')
    await there.open(id)
    await there.setBody(id, 'Ours and theirs')
    await there.flush()
    await here.mergeStored()
    await here.flush()
    writes.length = 0

    await here.setPinned(id, true)
    await here.flush()
    expect(writes).toEqual(['meta'])
    expect(await sqlite.getNote(id)).toMatchObject({ pinned: true, bodyMd: 'Ours and theirs' })
  })

  it('write a pending deletion whole after taking in a stored copy another process moved', async () => {
    const { sqlite, writes, service } = watched()
    const here = service('mac1')
    const id = await here.create('Plan')
    await here.setBody(id, 'Ours')
    await here.agentWrite(id, {
      writer: newWriter('mcp', 'Claude Code', 'mcp00aa11bb22cc'),
      markdown: 'Agent text.\n',
    })
    await here.flush()
    const storedWrites = async () => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, (await sqlite.getNote(id))!.ydoc)
      return doc.getMap(WRITES).size
    }
    expect(await storedWrites()).toBeGreaterThan(0)
    const there = service('mac2')
    await there.open(id)
    await there.setPinned(id, true)
    await there.flush()

    await here.clearAuthorship(id)
    await here.mergeStored()
    writes.length = 0
    await here.flush()
    expect(writes).toEqual(['note'])
    expect(await storedWrites()).toBe(0)
  })

  it('write the whole note when the stored body falls short of the document', async () => {
    const { sqlite, writes, service } = watched()
    const notes = service()
    const id = await notes.create('Plan')
    await notes.setBody(id, 'Real text')
    await notes.flush()
    const stored = await sqlite.getNote(id)
    await sqlite.putNote({ ...stored!, bodyMd: 'Out of step' })
    writes.length = 0

    await notes.mergeStored()
    await notes.flush()
    expect(writes).toEqual(['note'])
    expect((await sqlite.getNote(id))?.bodyMd).toBe('Real text')
  })

  it('write the whole note when storage no longer has it', async () => {
    const { sqlite, writes, service } = watched(() => ({
      putNoteMeta: async () => {
        writes.push('meta')
        throw new Error('E_NOTE_NOT_FOUND')
      },
    }))
    const notes = service()
    const id = await notes.create('Plan')
    await notes.setBody(id, 'Text')
    await notes.flush()
    writes.length = 0
    await notes.setTitle(id, 'Renamed')
    await notes.flush()
    expect(writes).toEqual(['meta', 'note'])
    expect(await sqlite.getNote(id)).toMatchObject({ title: 'Renamed', bodyMd: 'Text' })
  })

  it('write the fields alone for a note not in memory', async () => {
    const { sqlite, writes, service } = watched()
    const id = await service().create('Plan')
    writes.length = 0
    await service().writeMeta(id, { status: 'completed' })
    expect(writes).toEqual(['meta'])
    expect((await sqlite.getNote(id))?.status).toBe('completed')
  })
})
