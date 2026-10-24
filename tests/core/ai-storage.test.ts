// AiStorage made of the plain adapter's calls (aiStorageOver, for the app's
// storage) answers as devot-mcp's SQL does, on the same database.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  aiStorageOver,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  parseSearch,
  resolveSearch,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

it('answers every AI query as the SQL does', async () => {
  const storage = openSqliteAdapter(join(tempDir('devot-ai-storage-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const books = createBookService({ storage, clock, newId })
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  const a = await books.create('A', null, { aiAccess: true })
  const b = await books.create('B', null, { aiAccess: true })
  const c = await books.create('C', null)
  const ids: string[] = []
  for (const [i, book] of [a, a, b, c, null, a].entries()) {
    const id = await notes.create(`Note ${i} kiwi`, book)
    await notes.setBody(id, `Body ${i}: kiwi ${'x'.repeat(i)}\n`)
    ids.push(id)
  }
  await tags.addToNote(ids[0]!, 'fruit')
  await tags.addToNote(ids[1]!, 'fruit')
  await tags.addToNote(ids[2]!, 'Green')
  await tags.addToNote(ids[3]!, 'secret')
  const gone = await tags.addToNote(ids[1]!, 'gone')
  await tags.remove(gone)
  await notes.trash(ids[5]!)
  await notes.flush()

  const over = aiStorageOver(storage)
  const allowed = [a, b]
  const sorted = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((x, y) => x.id.localeCompare(y.id))

  expect(await over.countNotesInBooks(allowed)).toEqual(await storage.countNotesInBooks(allowed))
  expect(sorted(await over.tagsInBooks(allowed))).toEqual(
    sorted(await storage.tagsInBooks(allowed)),
  )
  for (const id of ids) {
    expect(sorted(await over.noteTags(id))).toEqual(sorted(await storage.noteTags(id)))
  }
  const query = resolveSearch(parseSearch('kiwi'), {
    books: await storage.listBooks(),
    tags: await storage.listTags(),
  })!
  for (const limit of [1, 2, 50]) {
    expect(await over.searchNotesInBooks(query, allowed, limit)).toEqual(
      await storage.searchNotesInBooks(query, allowed, limit),
    )
  }
  expect(await over.searchNotesInBooks(query, [], 10)).toEqual([])
})
