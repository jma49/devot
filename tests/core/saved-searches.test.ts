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
  pinTagNames,
  savedSearchQuery,
  type SavedSearchRecord,
} from '../../src/core'
import { createSyncEngine } from '../../src/core/sync/engine'
import { openSqliteAdapter, SCHEMA_VERSION, type SqliteAdapter } from '../support/sqlite-adapter'
import { FakeTransport, FakeVault } from '../support/sync-fake'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
const engines: { stop(): Promise<void> }[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop()
  open.splice(0).forEach((a) => a.close())
})

/** `setup` with a sync engine on the same storage, through a vault shared with other devices. */
function syncing(vault: FakeVault, node: string) {
  const device = setup(node)
  const transport = new FakeTransport(vault)
  const engine = createSyncEngine({
    storage: device.storage,
    sync: device.storage,
    transport,
    clock: device.clock,
    newId: createIdGenerator(),
    retryBaseMs: 1,
    idleMs: 10,
    everyMs: 40,
    random: () => 0.5,
  })
  engine.start()
  engines.push(engine)
  return { ...device, engine }
}

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
    expect((await searches.list())[0]).toMatchObject({
      id: work,
      query: 'is:active tag:work',
    })
    await searches.rename(work, 'Work')
    await searches.setQuery(work, 'is:active -tag:done')
    expect((await searches.list())[0]).toMatchObject({
      name: 'Work',
      query: 'is:active -tag:done',
    })
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
    expect(row?.search).toMatchObject({
      id,
      name: 'Later',
      query: 'is:on_hold',
    })
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

describe('saving a #Name that names a tag', () => {
  const tags = [
    { id: '1', name: 'urgent' },
    { id: '2', name: 'Big Clients' },
  ]

  it('spells it tag:Name, kept in place, and leaves the rest as written', () => {
    expect(pinTagNames('#Urgent', tags)).toBe('tag:urgent')
    expect(pinTagNames('-#urgent  is:active', tags)).toBe('-tag:urgent  is:active')
    expect(pinTagNames('relay #"big clients" #include "#urgent"', tags)).toBe(
      'relay tag:"Big Clients" #include "#urgent"',
    )
    expect(pinTagNames('tag:urgent title:#x', tags)).toBe('tag:urgent title:#x')
  })

  it('still runs with no matches once the tag is deleted', async () => {
    const { searches, notes, tags: tagService, books, storage } = setup()
    const note = await notes.create('Launch')
    const tag = await tagService.addToNote(note, 'urgent')
    await notes.flush()
    const hash = await searches.create('Hash', '#urgent')
    const negated = await searches.create('Not', '-#urgent')
    const unknown = await searches.create('Unknown', '#later')
    const edited = await searches.create('Edited', 'is:active')
    await searches.setQuery(edited, 'is:active #Urgent')
    const saved = Object.fromEntries((await searches.list()).map((s) => [s.id, s.query]))
    expect(saved).toEqual({
      [hash]: 'tag:urgent',
      [negated]: '-tag:urgent',
      [unknown]: '#later',
      [edited]: 'is:active tag:urgent',
    })
    await tagService.remove(tag)
    const context = { books: await books.list(), tags: await tagService.list() }
    expect(savedSearchQuery({ query: saved[hash]! }, context)).toBeNull()
    expect(
      countMatches(await storage.listNotes(), savedSearchQuery({ query: saved[hash]! }, context)),
    ).toBe(0)
    const without = savedSearchQuery({ query: saved[negated]! }, context)
    expect(countMatches(await storage.listNotes(), without)).toBe(1)
    const text = savedSearchQuery({ query: saved[unknown]! }, context)?.text
    expect(text?.map((t) => t.value)).toEqual(['#later'])
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
      Promise.all([books.list(), tags.list()]).then(([b, t]) => ({
        books: b,
        tags: t,
      }))
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

describe('renaming a tag a saved search names', () => {
  const queries = async (searches: ReturnType<typeof setup>['searches']) =>
    Object.fromEntries((await searches.list()).map((s) => [s.name, s.query]))

  it('keeps the search matching the same notes', async () => {
    const { searches, notes, tags, books, storage } = setup()
    const plan = await notes.create('Plan')
    await notes.create('Other')
    const tag = await tags.addToNote(plan, 'work')
    await notes.flush()
    await searches.create('Work', 'pinned:false tag:work')
    await searches.create('Not work', '-tag:work')
    const run = async (name: string) => {
      const search = (await searches.list()).find((s) => s.name === name)!
      const query = savedSearchQuery(search, { books: await books.list(), tags: await tags.list() })
      return countMatches(await storage.listNotes(), query)
    }
    expect([await run('Work'), await run('Not work')]).toEqual([1, 1])
    await tags.rename(tag, 'projects')
    expect(await queries(searches)).toEqual({
      Work: 'pinned:false tag:projects',
      'Not work': '-tag:projects',
    })
    expect([await run('Work'), await run('Not work')]).toEqual([1, 1])
  })

  it('rewrites only the clauses naming the tag, folding case like a search does', async () => {
    const { searches, tags } = setup()
    const tag = await tags.ensure('Work')
    await tags.ensure('Home')
    await searches.create(
      'Mixed',
      'tag:WORK  -tag:Home "tag:work" title:work #work is:active  tagId:x',
    )
    await searches.create('Untouched', 'tag:Home work')
    await searches.create('Unknown', '#later tag:later')
    await tags.rename(tag, 'Office')
    expect(await queries(searches)).toEqual({
      Mixed: 'tag:Office  -tag:Home "tag:work" title:work tag:Office is:active  tagId:x',
      Untouched: 'tag:Home work',
      Unknown: '#later tag:later',
    })
  })

  it('round-trips names with spaces and quotes, falling back to the ID when none holds', async () => {
    const { searches, tags, books, storage, notes } = setup()
    const note = await notes.create('Plan')
    const tag = await tags.addToNote(note, 'plain')
    await notes.flush()
    const id = await searches.create('Plain', '-tag:plain pinned:false')
    const check = async (name: string, query: string) => {
      await tags.rename(tag, name)
      const search = (await searches.list()).find((s) => s.id === id)!
      expect(search.query).toBe(query)
      const run = savedSearchQuery(search, { books: await books.list(), tags: await tags.list() })
      expect(countMatches(await storage.listNotes(), run)).toBe(0)
    }
    await check('Big Clients', '-tag:"Big Clients" pinned:false')
    await check('Say "hi"', `-tag:'Say "hi"' pinned:false`)
    await check('after', '-tag:after pinned:false')
    await check('Clients\' "urgent"', `-tagId:${tag} pinned:false`)
    await check('plain again', `-tagId:${tag} pinned:false`)
  })

  it('writes the edited searches, and only those, as pending sync records', async () => {
    const { searches, tags, storage } = setup()
    const tag = await tags.ensure('work')
    const named = await searches.create('Named', 'tag:work')
    const other = await searches.create('Other', 'is:active')
    for (const id of [tag, named, other]) {
      const [row] = await storage.syncRead([id])
      await storage.syncPut({
        ...row!.entry!,
        version: 1,
        fingerprint: 'f',
        synced: row!.entry!.edits,
      })
    }
    expect(await storage.syncPending('', 10)).toEqual([])
    await tags.rename(tag, 'office')
    expect((await storage.syncPending('', 10)).map((p) => p.id).sort()).toEqual([named, tag].sort())
    const [row] = await storage.syncRead([named])
    expect(row?.search).toMatchObject({ query: 'tag:office' })
  })

  it('leaves everything as it was when a write of the rename fails', async () => {
    const { searches, tags, storage } = setup()
    const tag = await tags.ensure('work')
    const id = await searches.create('Named', 'tag:work')
    const [stored] = await storage.listSavedSearches()
    await expect(
      storage.renameTag(
        { ...(await storage.listTags())[0]!, name: 'office', nameHlc: '9'.repeat(8) },
        [{ ...stored!, query: 'tag:office', queryHlc: '9'.repeat(8), createdAt: Number.NaN }],
      ),
    ).rejects.toThrow(/./)
    expect((await tags.list()).find((t) => t.id === tag)?.name).toBe('work')
    expect((await searches.list()).find((s) => s.id === id)?.query).toBe('tag:work')
  })

  it('spells the tag by ID when the name would make the query too long', async () => {
    const { searches, tags } = setup()
    const tag = await tags.ensure('work')
    const room = await searches.create('Room', `${'w'.repeat(940)} tag:work`)
    await tags.rename(tag, 'n'.repeat(90))
    expect((await searches.list())[0]?.query).toBe(`${'w'.repeat(940)} tagId:${tag}`)
    expect(room).toBe((await searches.list())[0]?.id)
  })

  it('refuses the rename, changing nothing, when a query could not keep naming the tag', async () => {
    const { searches, tags } = setup()
    const tag = await tags.ensure('work')
    const small = await searches.create('Small', 'tag:work')
    await searches.create('Full', `${'w'.repeat(990)} tag:work`)
    await expect(tags.rename(tag, 'n'.repeat(90))).rejects.toThrow('E_TAG_RENAME_SEARCH_TOO_LONG')
    expect((await tags.list())[0]?.name).toBe('work')
    expect((await searches.list()).find((s) => s.id === small)?.query).toBe('tag:work')
  })

  it('does not let a clause run into the next when a quoted name is replaced', async () => {
    const { searches, tags } = setup()
    const tag = await tags.ensure('work')
    await searches.create('Glued', 'tag:"work"title:plan')
    await tags.rename(tag, 'office')
    expect((await searches.list())[0]?.query).toBe('tag:office title:plan')
  })

  it('leaves a clause alone while another tag still has the old name', async () => {
    const { searches, tags, storage } = setup()
    const work = await tags.ensure('Work')
    const [mine] = await tags.list()
    const twin = '0190a000-0000-7000-8000-0000000000aa'
    await storage.putTag({ ...mine!, id: twin })
    await searches.create('Work', 'tag:Work -tag:work is:active')
    await tags.rename(work, 'Office')
    expect((await searches.list())[0]?.query).toBe('tag:Work -tag:work is:active')
  })

  it('keeps both renames when one is pulled while a tag is renamed here', async () => {
    const vault = new FakeVault()
    const mac = syncing(vault, 'mac1')
    const phone = syncing(vault, 'phone1')
    const work = await mac.tags.ensure('work')
    const home = await mac.tags.ensure('home')
    await mac.engine.syncNow()
    await phone.engine.syncNow()
    // Saved after the phone last pulled, so only the rename pulled here rewrites it.
    await mac.searches.create('Both', 'tag:work tag:home')
    await phone.tags.rename(work, 'office')
    await phone.engine.syncNow()
    const put = mac.storage.putSavedSearch.bind(mac.storage)
    let reached!: () => void
    const atWrite = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let first = true
    mac.storage.putSavedSearch = async (search) => {
      if (first) {
        first = false
        reached()
        await held
      }
      return put(search)
    }
    const pulled = mac.engine.syncNow()
    await atWrite
    const renamed = mac.tags.rename(home, 'house')
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([pulled, renamed])
    expect((await mac.searches.list())[0]?.query).toBe('tag:office tag:house')
  })

  it('keeps both rewrites when two tags in one query are renamed at once', async () => {
    const { searches, tags } = setup()
    const work = await tags.ensure('work')
    const home = await tags.ensure('home')
    await searches.create('Both', 'tag:work tag:home')
    await Promise.all([tags.rename(work, 'office'), tags.rename(home, 'house')])
    expect((await searches.list())[0]?.query).toBe('tag:office tag:house')
  })
})
