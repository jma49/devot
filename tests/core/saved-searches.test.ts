import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countMatches,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createSavedSearchService,
  createTagService,
  savedSearchQuery,
  type SavedSearchRecord,
} from '../../src/core'
import { openSqliteAdapter, SCHEMA_VERSION, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup(node = 'mac1', path = join(tempDir('devot-saved-searches-'), 'devot.sqlite')) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const clock = createClock(node)
  const newId = createIdGenerator()
  return {
    storage,
    path,
    clock,
    searches: createSavedSearchService({ storage, clock, newId }),
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
  }
}

const names = (all: SavedSearchRecord[]) => all.map((s) => s.name)

describe('saved searches on SQLite', () => {
  it('creates, lists in order, renames, changes the query and deletes', async () => {
    const { searches } = setup()
    const work = await searches.create('  Open work ', 'is:active tag:work ')
    await searches.create('Reading', '#reading')
    expect(names(await searches.list())).toEqual(['Open work', 'Reading'])
    expect((await searches.list())[0]).toMatchObject({ id: work, query: 'is:active tag:work' })
    await searches.rename(work, 'Work')
    await searches.setQuery(work, 'is:active -tag:done')
    expect((await searches.list())[0]).toMatchObject({ name: 'Work', query: 'is:active -tag:done' })
    await searches.remove(work)
    expect(names(await searches.list())).toEqual(['Reading'])
    await expect(searches.rename(work, 'Gone')).rejects.toThrow('E_SAVED_SEARCH_NOT_FOUND')
  })

  it('refuses empty, multi-line or overlong names and queries', async () => {
    const { searches } = setup()
    for (const name of ['', '  ', 'a\nb', 'x'.repeat(101)]) {
      await expect(searches.create(name, 'is:active')).rejects.toThrow(
        'E_SAVED_SEARCH_NAME_INVALID',
      )
    }
    for (const query of ['', ' \t', 'a\rb', 'q'.repeat(1001)]) {
      await expect(searches.create('Fine', query)).rejects.toThrow('E_SAVED_SEARCH_QUERY_INVALID')
    }
    expect(await searches.list()).toEqual([])
  })

  it('survives a relaunch on the same database', async () => {
    const first = setup()
    await first.searches.create('Pinned', 'pinned:true')
    first.storage.close()
    open.splice(open.indexOf(first.storage), 1)
    const again = setup('mac1', first.path)
    expect(names(await again.searches.list())).toEqual(['Pinned'])
    expect(again.storage.schemaVersion()).toBe(SCHEMA_VERSION)
  })

  it('reorders by placing a row before or after another, rewriting only that row', async () => {
    const { searches, storage } = setup()
    const a = await searches.create('A', 'a')
    const b = await searches.create('B', 'b')
    const c = await searches.create('C', 'c')
    const keysBefore = new Map((await storage.listSavedSearches()).map((s) => [s.id, s.sortKey]))
    await searches.place(c, a, 'before')
    expect(names(await searches.list())).toEqual(['C', 'A', 'B'])
    const keysAfter = new Map((await storage.listSavedSearches()).map((s) => [s.id, s.sortKey]))
    expect(keysAfter.get(a)).toBe(keysBefore.get(a))
    expect(keysAfter.get(b)).toBe(keysBefore.get(b))
    await searches.place(a, b, 'after')
    expect(names(await searches.list())).toEqual(['C', 'B', 'A'])
    await searches.place(a, a, 'before')
    expect(names(await searches.list())).toEqual(['C', 'B', 'A'])
    await expect(searches.place(a, 'nope', 'before')).rejects.toThrow('E_SAVED_SEARCH_NOT_FOUND')
  })

  it('marks every write pending for sync under its own kind', async () => {
    const { searches, storage } = setup()
    const id = await searches.create('Later', 'is:on_hold')
    const [row] = await storage.syncRead([id])
    expect(row?.entry).toMatchObject({ kind: 'search', version: 0 })
    expect(row?.search).toMatchObject({ id, name: 'Later', query: 'is:on_hold' })
    expect(row?.note ?? row?.book ?? row?.tag ?? row?.file).toBeNull()
    await storage.syncPut({
      ...row!.entry!,
      version: 2,
      fingerprint: 'f',
      synced: row!.entry!.edits,
    })
    expect((await storage.syncPending('', 10)).map((p) => p.id)).toEqual([])
    await searches.rename(id, 'Soon')
    expect((await storage.syncPending('', 10)).map((p) => p.id)).toEqual([id])
    await searches.remove(id)
    expect((await storage.syncRead([id]))[0]?.search?.deletedAt).toEqual(expect.any(Number))
  })

  it('keeps the newer value of each field from another device', async () => {
    const { searches, storage, clock } = setup()
    const id = await searches.create('Work', 'tag:work')
    const [mine] = await storage.listSavedSearches()
    const later = clock.tick()
    await storage.putSavedSearch({ ...mine!, name: 'Office', nameHlc: later })
    await storage.putSavedSearch({
      ...mine!,
      query: 'stale',
      queryHlc: '0000000000000001-0000-old',
      sortKey: 'zz',
      sortKeyHlc: '0000000000000001-0000-old',
    })
    expect((await searches.list())[0]).toMatchObject({
      id,
      name: 'Office',
      query: 'tag:work',
      sortKey: mine!.sortKey,
    })
  })
})

describe('counting what a saved search matches', () => {
  it('follows status and tag changes of the listed notes', async () => {
    const { notes, tags, books, storage } = setup()
    const plan = await notes.create('Plan')
    const idea = await notes.create('Idea')
    await notes.setStatus(plan, 'active')
    const work = await tags.addToNote(plan, 'work')
    await notes.flush()
    const context = { books: await books.list(), tags: await tags.list() }
    const active = savedSearchQuery({ query: 'is:active tag:work' }, context)
    expect(countMatches(await storage.listNotes(), active)).toBe(1)
    await notes.setStatus(plan, 'completed')
    await notes.flush()
    expect(countMatches(await storage.listNotes(), active)).toBe(0)
    await notes.setStatus(idea, 'active')
    await tags.putOnNote(idea, work)
    await notes.flush()
    expect(countMatches(await storage.listNotes(), active)).toBe(1)
    const unpinned = savedSearchQuery({ query: '-tag:work pinned:false' }, context)
    expect(countMatches(await storage.listNotes(), unpinned)).toBe(0)
    await tags.removeFromNote(plan, work)
    await notes.flush()
    expect(countMatches(await storage.listNotes(), unpinned)).toBe(1)
  })

  it('counts a search with text only by running it', async () => {
    const { notes, books, tags, storage } = setup()
    await notes.create('Relay design')
    await notes.flush()
    const context = { books: await books.list(), tags: await tags.list() }
    const query = savedSearchQuery({ query: 'relay is:none' }, context)
    expect(countMatches(await storage.listNotes(), query)).toBeNull()
    expect(await storage.searchNotes(query!, 10)).toHaveLength(1)
  })

  it('keeps running with no matches once the notebook or tag it names is gone', async () => {
    const { notes, tags, books, storage } = setup()
    const book = await books.create('Projects', null)
    const id = await notes.create('Launch', book)
    const tag = await tags.addToNote(id, 'urgent')
    await notes.flush()
    const context = () =>
      Promise.all([books.list(), tags.list()]).then(([b, t]) => ({ books: b, tags: t }))
    const byTag = { query: 'tag:urgent' }
    const byBook = { query: 'in:Projects' }
    expect(countMatches(await storage.listNotes(), savedSearchQuery(byTag, await context()))).toBe(
      1,
    )
    expect(countMatches(await storage.listNotes(), savedSearchQuery(byBook, await context()))).toBe(
      1,
    )
    await tags.remove(tag)
    await books.remove(book)
    expect(savedSearchQuery(byTag, await context())).toBeNull()
    expect(savedSearchQuery(byBook, await context())).toBeNull()
    expect(countMatches(await storage.listNotes(), savedSearchQuery(byTag, await context()))).toBe(
      0,
    )
    // Excluding a name nothing has excludes nothing.
    const without = savedSearchQuery({ query: '-tag:urgent' }, await context())
    expect(countMatches(await storage.listNotes(), without)).toBe(1)
  })

  it('keeps to the workspace it runs in', async () => {
    const { notes, tags, books, storage } = setup()
    const home = await books.create('Home', null)
    const work = await books.create('Work', null)
    const sub = await books.create('Clients', work)
    await notes.setStatus(await notes.create('Garden', home), 'active')
    await notes.setStatus(await notes.create('Pitch', sub), 'active')
    await notes.flush()
    const context = { books: await books.list(), tags: await tags.list() }
    const everywhere = savedSearchQuery({ query: 'is:active' }, context)
    expect(countMatches(await storage.listNotes(), everywhere)).toBe(2)
    const inWork = savedSearchQuery(
      { query: 'is:active' },
      { ...context, scope: { bookId: work, filter: null } },
    )
    expect(countMatches(await storage.listNotes(), inWork)).toBe(1)
    expect(savedSearchQuery({ query: '   ' }, context)).toBeNull()
  })
})
