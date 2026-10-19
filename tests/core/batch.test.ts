import Database from 'better-sqlite3'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyBatch,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: { close(): void }[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup(
  failing: ReadonlySet<string> = new Set(),
  refusal: unknown = new Error('E_TEST_WRITE'),
) {
  const path = join(tempDir('devot-batch-'), 'devot.sqlite')
  const sqlite = openSqliteAdapter(path)
  open.push(sqlite)
  const storage: StorageAdapter = Object.assign(Object.create(sqlite) as SqliteAdapter, {
    putNote: (record: Parameters<StorageAdapter['putNote']>[0]) =>
      failing.has(record.id) ? Promise.reject(refusal) : sqlite.putNote(record),
    putNoteTag: (link: Parameters<StorageAdapter['putNoteTag']>[0]) =>
      failing.has(link.noteId) ? Promise.reject(refusal) : sqlite.putNoteTag(link),
  })
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  const books = createBookService({ storage, clock, newId })
  const rows = () => {
    const db = new Database(path, { readonly: true })
    open.push(db)
    return {
      note: (id: string) =>
        db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Record<string, unknown>,
      noteTag: (noteId: string, tagId: string) =>
        db
          .prepare('SELECT * FROM note_tags WHERE note_id = ? AND tag_id = ?')
          .get(noteId, tagId) as Record<string, unknown> | undefined,
    }
  }
  return { storage, notes, tags, books, rows, services: { notes, tags } }
}

async function three(notes: ReturnType<typeof setup>['notes']) {
  return [await notes.create('A'), await notes.create('B'), await notes.create('C')]
}

const distinct = (values: unknown[]) => new Set(values).size === values.length

describe('batch changes on SQLite', () => {
  it('moves every note, each with its own notebook HLC', async () => {
    const { notes, books, rows, services } = setup()
    const ids = await three(notes)
    const book = await books.create('Work', null)
    const result = await applyBatch(services, ids, { kind: 'book', bookId: book })
    expect(result).toEqual({ changed: ids, failed: [] })
    const stored = ids.map((id) => rows().note(id))
    expect(stored.map((r) => r['book_id'])).toEqual([book, book, book])
    expect(distinct(stored.map((r) => r['book_hlc']))).toBe(true)
  })

  it('sets the status and the pin of every note, each with its own HLC', async () => {
    const { notes, rows, services } = setup()
    const ids = await three(notes)
    await applyBatch(services, ids, { kind: 'status', status: 'on_hold' })
    await applyBatch(services, ids, { kind: 'pinned', pinned: true })
    const stored = ids.map((id) => rows().note(id))
    expect(stored.map((r) => r['status'])).toEqual(['on_hold', 'on_hold', 'on_hold'])
    expect(stored.map((r) => r['pinned'])).toEqual([1, 1, 1])
    expect(distinct(stored.map((r) => r['status_hlc']))).toBe(true)
    expect(distinct(stored.map((r) => r['pinned_hlc']))).toBe(true)
    for (const id of ids) {
      const kinds = (await notes.history(id)).map((e) => e.kind)
      expect(kinds).toContain('status')
      expect(kinds).toContain('pinned')
    }
  })

  it('adds a tag (made once) and removes it, one membership write per note', async () => {
    const { notes, tags, rows, services } = setup()
    const ids = await three(notes)
    await applyBatch(services, ids, { kind: 'addTag', name: 'review' })
    const made = await tags.list()
    expect(made.map((t) => t.name)).toEqual(['review'])
    const tagId = made[0]!.id
    expect((await notes.list()).every((n) => n.tagIds.includes(tagId))).toBe(true)
    const added = ids.map((id) => rows().noteTag(id, tagId)!)
    expect(added.map((r) => r['present'])).toEqual([1, 1, 1])
    expect(distinct(added.map((r) => r['hlc']))).toBe(true)

    await applyBatch(services, ids.slice(0, 2), { kind: 'removeTag', tagId })
    const removed = ids.map((id) => rows().noteTag(id, tagId)!)
    expect(removed.map((r) => r['present'])).toEqual([0, 0, 1])
    expect(distinct(removed.map((r) => r['hlc']))).toBe(true)
    expect(removed[0]!['hlc']! > added[0]!['hlc']!).toBe(true)
  })

  it('moves notes to the trash, restores them and deletes them permanently', async () => {
    const { notes, rows, services } = setup()
    const ids = await three(notes)
    await applyBatch(services, ids, { kind: 'trash' })
    expect(await notes.list()).toEqual([])
    expect(distinct(ids.map((id) => rows().note(id)['deleted_hlc']))).toBe(true)
    await applyBatch(services, ids.slice(0, 1), { kind: 'restore' })
    expect((await notes.list()).map((n) => n.id)).toEqual(ids.slice(0, 1))
    await applyBatch(services, ids.slice(1), { kind: 'purge' })
    expect(await notes.listTrash()).toEqual([])
  })

  it('goes on past a note that fails and reports it', async () => {
    const first = setup()
    const ids = await three(first.notes)
    await first.notes.trash(ids[1]!)
    const result = await applyBatch(first.services, ids, { kind: 'status', status: 'active' })
    expect(result.changed).toEqual([ids[0], ids[2]])
    expect(result.failed).toEqual([{ id: ids[1], code: 'E_NOTE_NOT_FOUND' }])
    expect(first.rows().note(ids[2]!)['status']).toBe('active')
  })

  it('leaves a note whose write failed as it was, also for its next save', async () => {
    const failing = new Set<string>()
    const { notes, rows, services } = setup(failing)
    const ids = await three(notes)
    // A note open in the editor stays in memory; its next save must not
    // write the change reported as failed.
    await notes.open(ids[0]!)
    failing.add(ids[0]!)
    const result = await applyBatch(services, ids, { kind: 'status', status: 'dropped' })
    expect(result.failed.map((f) => f.id)).toEqual([ids[0]])
    failing.clear()
    await notes.setTitle(ids[0]!, 'A again')
    await notes.flush()
    expect(rows().note(ids[0]!)['status']).toBe('none')
    expect(rows().note(ids[0]!)['title']).toBe('A again')
    expect(rows().note(ids[1]!)['status']).toBe('dropped')
  })

  it('refuses a tag name that cannot be one before any note changes', async () => {
    const { notes, tags, services } = setup()
    const ids = await three(notes)
    await expect(applyBatch(services, ids, { kind: 'addTag', name: '  ' })).rejects.toThrow(
      'E_TAG_NAME_INVALID',
    )
    expect(await tags.list()).toEqual([])
  })

  it('puts a tag picked by ID, even when another tag has the same name', async () => {
    const { storage, notes, tags, rows, services } = setup()
    const ids = await three(notes)
    const first = await tags.ensure('todo')
    const [stored] = await tags.list()
    const second = createIdGenerator()()
    await storage.putTag({ ...stored!, id: second, name: 'Todo', createdAt: stored!.createdAt })
    expect(await tags.ensure('TODO')).toBe(first)

    const result = await applyBatch(services, ids, { kind: 'putTag', tagId: second })
    expect(result).toEqual({ changed: ids, failed: [] })
    const listed = await notes.list()
    expect(listed.every((n) => n.tagIds.includes(second))).toBe(true)
    expect(listed.some((n) => n.tagIds.includes(first))).toBe(false)
    const added = ids.map((id) => rows().noteTag(id, second)!)
    expect(distinct(added.map((r) => r['hlc']))).toBe(true)
  })

  it('refuses a tag ID that names no live tag before any note changes', async () => {
    const { notes, tags, services } = setup()
    const ids = await three(notes)
    await expect(
      applyBatch(services, ids, { kind: 'putTag', tagId: createIdGenerator()() }),
    ).rejects.toThrow('E_TAG_NOT_FOUND')
    const gone = await tags.ensure('gone')
    await tags.remove(gone)
    await expect(applyBatch(services, ids, { kind: 'putTag', tagId: gone })).rejects.toThrow(
      'E_TAG_NOT_FOUND',
    )
    expect((await notes.list()).every((n) => n.tagIds.length === 0)).toBe(true)
  })

  it('reports a note whose write fails, and still changes the rest', async () => {
    const failing = new Set<string>()
    const { notes, rows, services } = setup(failing)
    const ids = await three(notes)
    failing.add(ids[0]!)
    const result = await applyBatch(services, ids, { kind: 'pinned', pinned: true })
    expect(result.changed).toEqual(ids.slice(1))
    expect(result.failed).toEqual([{ id: ids[0], code: 'E_TEST_WRITE' }])
    expect(ids.map((id) => rows().note(id)['pinned'])).toEqual([0, 1, 1])

    const tagged = await applyBatch(services, ids, { kind: 'addTag', name: 'x' })
    expect(tagged.failed.map((f) => f.id)).toEqual([ids[0]])
    expect(tagged.changed).toEqual(ids.slice(1))
  })

  it('reports the code a write was refused with, also when it is not an Error', async () => {
    const failing = new Set<string>()
    const { notes, services } = setup(failing, 'E_STORAGE_FULL')
    const ids = await three(notes)
    failing.add(ids[1]!)
    const pinned = await applyBatch(services, ids, { kind: 'pinned', pinned: true })
    expect(pinned.failed).toEqual([{ id: ids[1], code: 'E_STORAGE_FULL' }])
    const tagged = await applyBatch(services, ids, { kind: 'addTag', name: 'x' })
    expect(tagged.failed).toEqual([{ id: ids[1], code: 'E_STORAGE_FULL' }])
  })

  it('takes each note once and refuses an unknown change', async () => {
    const { notes, services } = setup()
    const [a] = await three(notes)
    const result = await applyBatch(services, [a!, a!], { kind: 'pinned', pinned: true })
    expect(result.changed).toEqual([a])
    await expect(
      applyBatch(services, [a!], { kind: 'status', status: 'later' as never }),
    ).rejects.toThrow('E_NOTE_STATUS_INVALID')
    await expect(applyBatch(services, [a!], { kind: 'nothing' } as never)).rejects.toThrow(
      'E_BATCH_INVALID',
    )
  })
})
