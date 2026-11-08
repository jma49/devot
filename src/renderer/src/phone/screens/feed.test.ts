// @vitest-environment happy-dom
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyBatch } from '../../../../core/batch'
import { createBookService } from '../../../../core/books'
import { createClock } from '../../../../core/hlc'
import { createIdGenerator } from '../../../../core/ids'
import { createNoteService } from '../../../../core/notes/service'
import { createSavedSearchService } from '../../../../core/savedSearches'
import { createTagService } from '../../../../core/tags'
import { welcomeSeed } from '../../../../core/welcome'
import { memoryStorage } from '../../storage/memory'
import { reportingNoteWrites } from '../../noteWrites'
import { fromWire, toWire } from '../../storage/wire'
import { welcomeContent } from '../../welcome/content'
import { externalChangesReported, reportingListWrites, type LibraryNotice } from './feed'
import { noteWritesReported, watchLibraryChanges, watchNoteChanges } from './noteChanges'

const heard: { rev: number; ids: readonly string[]; all: boolean }[] = []
const library: LibraryNotice[] = []
const stops = [
  watchNoteChanges((rev, ids, all) => heard.push({ rev, ids, all })),
  watchLibraryChanges((notice) => library.push(notice)),
]
afterEach(() => {
  heard.length = 0
  library.length = 0
})

function services() {
  // As the phone's core is given it: note saves reported as before, the rest by the feed.
  const saves = reportingNoteWrites(toWire(memoryStorage), (writes) =>
    noteWritesReported(writes.keys()),
  )
  const storage = fromWire(reportingListWrites(saves))
  const clock = createClock('feed1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  const books = createBookService({ storage, clock, newId })
  const searches = createSavedSearchService({ storage, clock, newId })
  return { notes, tags, books, searches }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('the native lists feed', () => {
  it('names the notes a tag change or a purge changed, which no note save reports', async () => {
    const { notes, tags } = services()
    const id = await notes.create('Plan')
    await settle()
    heard.length = 0
    await tags.addToNote(id, 'work')
    await settle()
    expect(heard.flatMap((change) => change.ids)).toContain(id)
    heard.length = 0
    await applyBatch({ notes, tags }, [id], { kind: 'trash' })
    await applyBatch({ notes, tags }, [id], { kind: 'purge' })
    await settle()
    expect(heard.flatMap((change) => change.ids)).toContain(id)
    expect(heard.every((change) => !change.all)).toBe(true)
  })

  it('numbers each change one after the other', async () => {
    const { notes } = services()
    await notes.create('One')
    await settle()
    await notes.create('Two')
    await settle()
    const revs = heard.map((change) => change.rev)
    expect(revs.length).toBeGreaterThanOrEqual(2)
    expect(revs.slice(1)).toStrictEqual(revs.slice(0, -1).map((rev) => rev + 1))
  })

  it('tells notebooks, tags and saved searches apart, once a moment', async () => {
    const { books, tags, notes, searches } = services()
    await Promise.all([books.create('Work', null), books.create('Home', null)])
    await settle()
    expect(new Set(library)).toStrictEqual(new Set(['books.changed']))
    library.length = 0
    const id = await notes.create('Tagged')
    await tags.addToNote(id, 'urgent')
    await settle()
    expect(library).toContain('tags.changed')
    library.length = 0
    await searches.create('Open', 'status:active')
    await settle()
    expect(library).toStrictEqual(['savedSearches.changed'])
  })

  const seeding = (seeded: boolean) =>
    reportingListWrites({ ...toWire(memoryStorage), seedWelcome: async () => seeded }).seedWelcome(
      welcomeSeed(welcomeContent(), '0', 0),
    )

  it('has every list read again once the first-launch notes are seeded', async () => {
    expect(await seeding(true)).toBe(true)
    expect(heard).toStrictEqual([expect.objectContaining({ ids: [], all: true })])
  })

  it('reports nothing when the library already held notes and nothing was seeded', async () => {
    expect(await seeding(false)).toBe(false)
    await settle()
    expect(heard).toStrictEqual([])
  })

  it('ends what sync took in with one change that every list reads again for', () => {
    externalChangesReported()
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatchObject({ ids: [], all: true })
  })
})

afterAll(() => {
  for (const stop of stops) stop()
})
