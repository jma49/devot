import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  TEMPLATES_BOOK_ID,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  observeWrites,
  semanticQuery,
  MAX_SEMANTIC_RESULTS,
  type NoteService,
  type SemanticHit,
  type SemanticQuery,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const words = (text: string) => new Set(text.toLowerCase().match(/\p{L}+/gu) ?? [])

/**
 * The store's side as src-tauri/src/semantic ranks it, with shared words standing in for a
 * sentence model: the filter's notes alone, best first.
 */
function withMeaning(storage: StorageAdapter, asked: SemanticQuery[], refusal?: string) {
  const semanticSearch = async (query: SemanticQuery): Promise<SemanticHit[]> => {
    asked.push(query)
    if (refusal) throw new Error(refusal)
    const shown = await storage.searchNotes(query.filter, 200)
    const bodies = await storage.getBodies(shown.map((n) => n.id))
    const wanted = words(query.text)
    return shown
      .map((summary) => {
        const body = bodies.find((b) => b.id === summary.id)?.bodyMd ?? ''
        const shared = [...words(`${summary.title} ${body}`)].filter((w) => wanted.has(w))
        return { ...summary, score: shared.length / wanted.size, excerpt: body.slice(0, 40) }
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit)
  }
  return Object.assign(storage, { semanticSearch })
}

function setup(refusal?: string) {
  const asked: SemanticQuery[] = []
  const storage = openSqliteAdapter(join(tempDir('devot-semantic-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const logged: string[][] = []
  const notes = createNoteService({
    storage: withMeaning(storage, asked, refusal),
    clock,
    newId,
    saveDelayMs: 5,
    log: (...line) => logged.push(line),
  })
  const books = createBookService({ storage, clock, newId })
  return { notes, books, asked, logged }
}

async function note(notes: NoteService, title: string, body: string, bookId: string | null = null) {
  const id = await notes.create(title, bookId)
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  const before = Y.encodeStateVector(doc)
  doc.getText(BODY).insert(0, body)
  await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
  await notes.flush()
  return id
}

describe('semanticQuery', () => {
  const text = (value: string, negate = false) => ({ field: 'any' as const, value, negate })

  it('reads the words asked for and keeps everything else as the filter', () => {
    const query = {
      text: [
        text('garden'),
        text('draft', true),
        { field: 'title' as const, value: 'plan', negate: false },
      ],
      sets: [{ kind: 'book' as const, ids: ['b'], negate: false }],
      pinned: true,
    }
    expect(semanticQuery(query, 10)).toEqual({
      text: 'garden plan',
      filter: { text: [text('draft', true)], sets: query.sets, pinned: true },
      limit: 10,
      passages: false,
    })
  })

  it('asks nothing for too few words and keeps the limit in range', () => {
    const none = { text: [text('draft', true)], sets: [], pinned: null }
    expect(semanticQuery(none, 10)).toBeNull()
    expect(semanticQuery({ ...none, text: [text('ab')] }, 10)).toBeNull()
    expect(semanticQuery({ ...none, text: [text('abc')] }, 999)?.limit).toBe(MAX_SEMANTIC_RESULTS)
    expect(semanticQuery({ ...none, text: [text('abc')] }, 0)?.limit).toBe(1)
    expect(semanticQuery({ ...none, text: [text('x'.repeat(2000))] }, 5)?.text).toHaveLength(1000)
  })
})

describe('searchByMeaning', () => {
  it('finds notes by their words in the scope the search has, never Templates', async () => {
    const s = setup()
    const work = await s.books.create('Work', null)
    await note(s.notes, 'Garden', 'Water the tomatoes every morning.')
    const inWork = await note(s.notes, 'Watering', 'Tomatoes and water schedule.', work)
    await note(s.notes, 'Template', 'Water tomatoes template.', TEMPLATES_BOOK_ID)
    await note(s.notes, 'Taxes', 'File the forms.')
    const everywhere = await s.notes.searchByMeaning('water tomatoes')
    expect(everywhere.map((n) => n.title).sort()).toEqual(['Garden', 'Watering'])
    const scoped = await s.notes.searchByMeaning('water tomatoes', { bookId: work, filter: null })
    expect(scoped.map((n) => n.id)).toEqual([inWork])
    expect(scoped[0]).not.toHaveProperty('score')
    expect(scoped[0]?.excerpt).toBe('Tomatoes and water schedule.')
  })

  it('keeps qualifiers and excluded words as the filter', async () => {
    const s = setup()
    await note(s.notes, 'Garden', 'Water the tomatoes. Draft.')
    await note(s.notes, 'Balcony', 'Water the tomatoes on the balcony.')
    const found = await s.notes.searchByMeaning('water tomatoes -draft')
    expect(found.map((n) => n.title)).toEqual(['Balcony'])
    expect(s.asked.at(-1)?.text).toBe('water tomatoes')
    expect(s.asked.at(-1)?.filter.text).toEqual([{ field: 'any', value: 'draft', negate: true }])
  })

  it('asks storage nothing for a query of qualifiers alone or too short a word', async () => {
    const s = setup()
    await note(s.notes, 'Garden', 'Water')
    expect(await s.notes.searchByMeaning('pinned:true')).toEqual([])
    expect(await s.notes.searchByMeaning('ab')).toEqual([])
    expect(await s.notes.searchByMeaning('   ')).toEqual([])
    expect(s.asked).toEqual([])
  })

  it('answers nothing when the store refuses, and stops asking where there is no model', async () => {
    const s = setup('E_SEMANTIC_UNAVAILABLE')
    expect(await s.notes.searchByMeaning('water tomatoes')).toEqual([])
    expect(await s.notes.searchByMeaning('water tomatoes')).toEqual([])
    expect(s.asked).toHaveLength(1)
    expect(s.logged).toContainEqual(['I_SEMANTIC_SEARCH_SKIPPED', 'E_SEMANTIC_UNAVAILABLE'])
  })

  it('asks again after a refusal that may pass, such as the licence', async () => {
    const s = setup('E_LICENCE_REQUIRED')
    await s.notes.searchByMeaning('water tomatoes')
    await s.notes.searchByMeaning('water tomatoes')
    expect(s.asked).toHaveLength(2)
  })
})

describe('observeWrites', () => {
  it('passes semantic search and its status through to the store', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-semantic-'), 'devot.sqlite'))
    open.push(storage)
    const asked: SemanticQuery[] = []
    const observed = observeWrites(
      Object.assign(withMeaning(storage, asked), {
        semanticStatus: async () => ({ state: 'ready' as const, notes: 0 }),
      }),
      () => {},
    )
    const query = semanticQuery(
      { text: [{ field: 'any', value: 'garden', negate: false }], sets: [], pinned: null },
      5,
    )!
    await expect(observed.semanticSearch?.(query)).resolves.toEqual([])
    expect(asked).toEqual([query])
    await expect(observed.semanticStatus?.()).resolves.toEqual({ state: 'ready', notes: 0 })
  })

  it('leaves semantic search out where the store has none', () => {
    const storage = openSqliteAdapter(join(tempDir('devot-semantic-'), 'devot.sqlite'))
    open.push(storage)
    const observed = observeWrites(storage, () => {})
    expect(observed.semanticSearch).toBeUndefined()
    expect(observed.semanticStatus).toBeUndefined()
  })
})
