import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  filterNotes,
  noteGroups,
  statusCounts,
  TAG_COLORS,
  tagCounts,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-tags-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    storage,
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
  }
}

describe('tags on SQLite', () => {
  it('adds a tag by name, reusing an existing tag regardless of case', async () => {
    const { notes, tags } = setup()
    const a = await notes.create('A')
    const b = await notes.create('B')
    const sync = await tags.addToNote(a, 'sync')
    expect(await tags.addToNote(b, '  Sync ')).toBe(sync)
    expect((await tags.list()).map((t) => t.name)).toEqual(['sync'])
    const listed = await notes.list()
    expect(listed.every((n) => n.tagIds.includes(sync))).toBe(true)
  })

  it('removes a tag from a note and adds it back', async () => {
    const { notes, tags } = setup()
    const id = await notes.create('A')
    const tag = await tags.addToNote(id, 'idea')
    await tags.removeFromNote(id, tag)
    expect((await notes.list())[0]?.tagIds).toEqual([])
    await tags.addToNote(id, 'idea')
    expect((await notes.list())[0]?.tagIds).toEqual([tag])
  })

  it('refuses empty, multi-line or overlong tag names', async () => {
    const { notes, tags } = setup()
    const id = await notes.create('A')
    for (const name of ['', '  ', 'a\nb', 'x'.repeat(101)]) {
      await expect(tags.addToNote(id, name)).rejects.toThrow('E_TAG_NAME_INVALID')
    }
  })

  it('renames a tag and deletes it from every note', async () => {
    const { notes, tags } = setup()
    const id = await notes.create('A')
    const tag = await tags.addToNote(id, 'old')
    await tags.rename(tag, 'new')
    expect((await tags.list()).map((t) => t.name)).toEqual(['new'])
    await tags.remove(tag)
    expect(await tags.list()).toEqual([])
    expect((await notes.list())[0]?.tagIds).toEqual([])
  })

  it('keeps the newer membership write', async () => {
    const { storage, notes, tags } = setup()
    const id = await notes.create('A')
    const tag = await tags.addToNote(id, 'x')
    await storage.putNoteTag({
      noteId: id,
      tagId: tag,
      present: false,
      hlc: '0000000000000001-0000-old',
    })
    expect((await notes.list())[0]?.tagIds).toEqual([tag])
  })
})

describe('tag colours on SQLite', () => {
  it('starts without a colour, sets each palette colour and takes it off', async () => {
    const { notes, tags } = setup()
    const id = await tags.addToNote(await notes.create('A'), 'idea')
    expect(await tags.list()).toMatchObject([{ id, color: null, colorHlc: '' }])
    for (const color of TAG_COLORS) {
      await tags.setColor(id, color)
      expect((await tags.list())[0]?.color).toBe(color)
    }
    await tags.setColor(id, null)
    const [tag] = await tags.list()
    expect(tag?.color).toBeNull()
    expect(tag?.colorHlc).not.toBe('')
  })

  it('refuses a colour outside the palette and an unknown tag', async () => {
    const { notes, tags } = setup()
    const id = await tags.addToNote(await notes.create('A'), 'idea')
    for (const color of ['magenta', 'Red', '#ff0000', '']) {
      await expect(tags.setColor(id, color as never)).rejects.toThrow('E_TAG_COLOR_INVALID')
    }
    await expect(tags.setColor('0192a6f0-0000-7000-8000-0000000000ff', 'red')).rejects.toThrow(
      'E_TAG_NOT_FOUND',
    )
  })

  it('keeps the colour through a rename and the name through a colour change', async () => {
    const { notes, tags } = setup()
    const id = await tags.addToNote(await notes.create('A'), 'idea')
    await tags.setColor(id, 'green')
    await tags.rename(id, 'ideas')
    await tags.setColor(id, 'blue')
    expect(await tags.list()).toMatchObject([{ name: 'ideas', color: 'blue' }])
  })

  it('merges the colour per field: a stale copy never undoes a newer colour', async () => {
    const { storage, notes, tags } = setup()
    const id = await tags.addToNote(await notes.create('A'), 'idea')
    await tags.setColor(id, 'red')
    const [current] = await tags.list()
    if (!current) throw new Error('no tag')
    // Another device renamed the tag later, from a copy with an older colour.
    await storage.putTag({
      ...current,
      name: 'later',
      nameHlc: '9999999999999999-0000-other',
      color: 'purple',
      colorHlc: '0000000000000001-0000-other',
    })
    expect(await tags.list()).toMatchObject([{ name: 'later', color: 'red' }])
    // A newer colour from elsewhere wins, even with an older name.
    await storage.putTag({
      ...current,
      name: 'stale',
      nameHlc: '0000000000000001-0000-other',
      color: 'yellow',
      colorHlc: '9999999999999999-0000-other',
    })
    expect(await tags.list()).toMatchObject([{ name: 'later', color: 'yellow' }])
  })

  it('reads a colour it does not know as none, keeping its HLC', async () => {
    const { storage, notes, tags } = setup()
    const id = await tags.addToNote(await notes.create('A'), 'idea')
    storage.db
      .prepare('UPDATE tags SET color = ?, color_hlc = ? WHERE id = ?')
      .run('ultraviolet', '9999999999999999-0000-later', id)
    expect(await tags.list()).toMatchObject([
      { color: null, colorHlc: '9999999999999999-0000-later' },
    ])
    // Renaming writes the record back without undoing the newer colour.
    await tags.rename(id, 'renamed')
    const row = storage.db.prepare('SELECT name, color FROM tags WHERE id = ?').get(id)
    expect(row).toEqual({ name: 'renamed', color: 'ultraviolet' })
  })
})

describe('status and pinning', () => {
  it('sets every status and pins notes', async () => {
    const { notes } = setup()
    const id = await notes.create('A')
    for (const status of ['active', 'on_hold', 'completed', 'dropped', 'none'] as const) {
      await notes.setStatus(id, status)
      await notes.flush()
      expect((await notes.list())[0]?.status).toBe(status)
    }
    await notes.setPinned(id, true)
    await notes.flush()
    expect((await notes.list())[0]?.pinned).toBe(true)
  })

  it('refuses unknown statuses', async () => {
    const { notes } = setup()
    const id = await notes.create('A')
    await expect(notes.setStatus(id, 'urgent' as never)).rejects.toThrow('E_NOTE_STATUS_INVALID')
  })

  it('puts pinned notes in their own group above the rest, each newest first', async () => {
    const { notes } = setup()
    const old = await notes.create('old pinned')
    await notes.create('plain')
    await notes.setPinned(old, true)
    await notes.flush()
    const groups = noteGroups(await notes.list())
    expect(groups.pinned.map((n) => n.title)).toEqual(['old pinned'])
    expect(groups.others.map((n) => n.title)).toEqual(['plain'])
  })
})

describe('filters combine with the notebook', () => {
  it('narrows by notebook and status, tag or pinned, and counts', async () => {
    const { notes, books, tags } = setup()
    const work = await books.create('Work', null)
    const a = await notes.create('work active', work)
    const b = await notes.create('work done', work)
    const c = await notes.create('loose active')
    await notes.setStatus(a, 'active')
    await notes.setStatus(b, 'completed')
    await notes.setStatus(c, 'active')
    await notes.setPinned(b, true)
    await notes.flush()
    const sync = await tags.addToNote(a, 'sync')
    await tags.addToNote(c, 'sync')

    const all = await notes.list()
    const bookList = await books.list()
    const titles = (filter: Parameters<typeof filterNotes>[2]) =>
      filterNotes(all, bookList, filter)
        .map((n) => n.title)
        .sort()
    expect(titles({ bookId: work, by: { kind: 'status', status: 'active' } })).toEqual([
      'work active',
    ])
    expect(titles({ bookId: null, by: { kind: 'status', status: 'active' } })).toEqual([
      'loose active',
      'work active',
    ])
    expect(titles({ bookId: work, by: { kind: 'tag', tagId: sync } })).toEqual(['work active'])
    expect(titles({ bookId: null, by: { kind: 'pinned' } })).toEqual(['work done'])
    expect(titles({ bookId: work, by: null })).toEqual(['work active', 'work done'])

    expect(statusCounts(all).get('active')).toBe(2)
    expect(tagCounts(all).get(sync)).toBe(2)
  })
})
