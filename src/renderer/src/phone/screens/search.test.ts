// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createClock } from '../../../../core/hlc'
import { createIdGenerator } from '../../../../core/ids'
import { createNoteService } from '../../../../core/notes/service'
import { parseSearch } from '../../../../core/search'
import { memoryStorage } from '../../storage/memory'
import { searchHandlers, titlesOnly, type SearchCore } from './search'

function searching() {
  const notes = createNoteService({
    storage: memoryStorage,
    clock: createClock('search1'),
    newId: createIdGenerator(),
    saveDelayMs: 60_000,
  })
  const asked: { query: string; flush: boolean | undefined }[] = []
  const core: SearchCore = {
    search: (query, scope, options) => {
      asked.push({ query, flush: options?.flush })
      return notes.search(query, scope, options)
    },
  }
  const handlers = searchHandlers(() => core)
  const run = (args: Record<string, unknown>) => {
    const handler = handlers.search
    if (!handler) throw new Error('no search handler')
    return handler(args) as Promise<{ rows: { id: string; excerpt?: string }[]; capped: boolean }>
  }
  return { notes, asked, run }
}

describe('the native Search tab operation', () => {
  it('answers the notes the core finds, in its order, with their excerpts', async () => {
    const { notes, run } = searching()
    const first = await notes.create('Quarterly zephyrine review')
    const second = await notes.create('Groceries')
    await notes.setBody(second, 'Milk, bread and zephyrine tea')
    await notes.flush()
    const found = await run({ query: 'zephyrine', scope: 'all' })
    expect(found.capped).toBe(false)
    expect(found.rows.map((row) => row.id).sort()).toStrictEqual([first, second].sort())
    expect(found.rows.find((row) => row.id === second)?.excerpt).toContain('zephyrine tea')
  })

  it('saves typing still pending before it searches, so a note just edited is found', async () => {
    const { notes, asked, run } = searching()
    const id = await notes.create('Draft')
    await notes.setBody(id, 'a quokkasaurus sighting')
    const found = await run({ query: 'quokkasaurus', scope: 'all' })
    expect(found.rows.map((row) => row.id)).toStrictEqual([id])
    expect(asked.at(-1)?.flush).toBe(true)
  })

  it('looks for plain words only in titles under Titles', async () => {
    const { notes, run } = searching()
    const titled = await notes.create('Marmoset budget')
    const bodied = await notes.create('Plans')
    await notes.setBody(bodied, 'the marmoset budget is in the body')
    await notes.flush()
    const all = await run({ query: 'marmoset', scope: 'all' })
    expect(all.rows.map((row) => row.id).sort()).toStrictEqual([titled, bodied].sort())
    const titles = await run({ query: 'marmoset', scope: 'titles' })
    expect(titles.rows.map((row) => row.id)).toStrictEqual([titled])
  })

  it('answers no rows for a query with no clauses, without asking the core', async () => {
    const { asked, run } = searching()
    expect(await run({ query: '   ', scope: 'all' })).toStrictEqual({ rows: [], capped: false })
    expect(asked).toStrictEqual([])
  })

  it('refuses while the core has not started', async () => {
    const handler = searchHandlers(() => null).search
    await expect(handler?.({ query: 'x', scope: 'all' })).rejects.toThrow('E_SCREENS_UNAVAILABLE')
  })
})

describe('the Titles scope', () => {
  const clauses = (query: string) => parseSearch(titlesOnly(query))

  it('turns each plain word and phrase into a title clause and keeps its minus', () => {
    expect(clauses('-draft "budget plan" week')).toStrictEqual([
      { field: 'title', value: 'draft', negate: true },
      { field: 'title', value: 'budget plan', negate: false },
      { field: 'title', value: 'week', negate: false },
    ])
  })

  it('keeps every qualified clause as it was read', () => {
    const query =
      'tag:work #home in:"Weekly notes" is:on_hold body:milk pinned:yes bookId:01890a5d-ac96-774b-bcce-b30209900001'
    expect(clauses(query)).toStrictEqual(parseSearch(query))
  })

  it('keeps a word with quotes in it whole', () => {
    expect(clauses(`don't 'tis "say "hi""`)).toStrictEqual(
      parseSearch(`don't 'tis "say "hi""`).map((clause) => ({ ...clause, field: 'title' })),
    )
  })
})
