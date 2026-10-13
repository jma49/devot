import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  highlightTerms,
  matchSegments,
  searchPattern,
  bodyExcerpt,
  parseSearch,
  resolveSearch,
  MAX_TERM_CHARS,
  SEARCH_LIMIT,
  type BookRecord,
  type NoteService,
  type SearchClause,
  type SearchScope,
  type TagRecord,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-search-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  return { storage, notes, books, tags }
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

const titles = async (notes: NoteService, query: string, scope?: SearchScope) =>
  (await notes.search(query, scope)).map((n) => n.title).sort()

const any = (value: string, negate = false): SearchClause => ({ field: 'any', value, negate })

// "\u540c\u6b65\u65b9\u6848" is a four-character Chinese phrase ("sync plan");
// "\u540c\u6b65" is its two-character first word.
const SYNC_PLAN = '\u540c\u6b65\u65b9\u6848'
const SYNC = '\u540c\u6b65'

/** Excerpt cases both stores agree on: a body built from repeated parts. */
interface ExcerptCase {
  name: string
  parts: [text: string, times: number][]
  terms: string[]
  excerpt: string | null
}
const EXCERPT_CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, '../support/excerpts.json'), 'utf8'),
) as ExcerptCase[]
const excerptBody = (parts: ExcerptCase['parts']) => parts.map(([t, n]) => t.repeat(n)).join('')

// 200 excerpts (a full page of results) of 110 KB bodies: reading each body
// whole took about a second.
const EXCERPTS_BUDGET_MS = 100

describe('parseSearch', () => {
  it('splits on spaces and keeps quoted phrases whole', () => {
    expect(parseSearch('  yjs   "offline merge"  relay ')).toEqual([
      any('yjs'),
      any('offline merge'),
      any('relay'),
    ])
  })

  it('ignores empty input and an unclosed quote', () => {
    expect(parseSearch('   ')).toEqual([])
    expect(parseSearch('""')).toEqual([])
    expect(parseSearch('"open quote')).toEqual([any('open quote')])
  })

  it('reads every qualifier, in any case', () => {
    expect(parseSearch('book:Work TAG:sync Status:active title:plan body:relay')).toEqual([
      { field: 'book', value: 'Work', negate: false },
      { field: 'tag', value: 'sync', negate: false },
      { field: 'status', value: 'active', negate: false },
      { field: 'title', value: 'plan', negate: false },
      { field: 'body', value: 'relay', negate: false },
    ])
  })

  it('quotes values with spaces, and phrases after any qualifier', () => {
    expect(parseSearch('book:"Weekly notes" tag:"to read" title:"sync plan" body:"a b"')).toEqual([
      { field: 'book', value: 'Weekly notes', negate: false },
      { field: 'tag', value: 'to read', negate: false },
      { field: 'title', value: 'sync plan', negate: false },
      { field: 'body', value: 'a b', negate: false },
    ])
    // An unclosed quote runs to the end, like a plain phrase.
    expect(parseSearch('book:"Weekly notes')).toEqual([
      { field: 'book', value: 'Weekly notes', negate: false },
    ])
  })

  it('excludes terms, phrases and qualifiers with a leading minus', () => {
    expect(parseSearch('-draft -"old plan" -tag:done -book:"Weekly notes"')).toEqual([
      any('draft', true),
      any('old plan', true),
      { field: 'tag', value: 'done', negate: true },
      { field: 'book', value: 'Weekly notes', negate: true },
    ])
  })

  it('reads statuses by display name or ID', () => {
    const status = (q: string) => parseSearch(q).map((c) => [c.field, c.value])
    expect(status('status:"On Hold"')).toEqual([['status', 'on_hold']])
    expect(status('status:on_hold status:on-hold status:ON-HOLD')).toEqual([
      ['status', 'on_hold'],
      ['status', 'on_hold'],
      ['status', 'on_hold'],
    ])
    expect(status('status:"No Status" status:none')).toEqual([
      ['status', 'none'],
      ['status', 'none'],
    ])
    expect(status('status:Completed status:dropped status:Active')).toEqual([
      ['status', 'completed'],
      ['status', 'dropped'],
      ['status', 'active'],
    ])
  })

  it('reads malformed input as plain text', () => {
    expect(parseSearch('book: -')).toEqual([any('book:'), any('-')])
    expect(parseSearch('status:urgent')).toEqual([any('status:urgent')])
    expect(parseSearch('-status:"later on"')).toEqual([any('status:"later on"', true)])
    expect(parseSearch('https://example.com due:today')).toEqual([
      any('https://example.com'),
      any('due:today'),
    ])
    expect(parseSearch('a-b --c')).toEqual([any('a-b'), any('-c', true)])
    expect(parseSearch('tag:""')).toEqual([any('tag:""')])
  })

  it('keeps at most ten clauses of at most 100 characters', () => {
    expect(parseSearch(Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '))).toHaveLength(10)
    expect(parseSearch(`title:${'x'.repeat(150)}`)[0]?.value).toHaveLength(100)
  })
})

describe('resolveSearch', () => {
  const book = (id: string, name: string, parentId: string | null = null): BookRecord => ({
    id,
    name,
    nameHlc: 'h',
    parentId,
    parentHlc: 'h',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    sortKey: '',
    sortKeyHlc: '',
  })
  const tag = (id: string, name: string): TagRecord => ({
    id,
    name,
    nameHlc: 'h',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    deletedHlc: null,
    color: null,
    colorHlc: '',
  })
  const books = [book('w', 'Work'), book('p', 'Projects', 'w'), book('h', 'Home')]
  const tags = [tag('s', 'Sync'), tag('r', 'to read')]

  it('finds notebooks with their sub-notebooks, and tags, by name in any case', () => {
    const q = resolveSearch(parseSearch('book:WORK tag:sync tag:"TO READ" plan'), { books, tags })
    expect(q).toEqual({
      text: [{ field: 'any', value: 'plan', negate: false }],
      sets: [
        { kind: 'book', ids: ['w', 'p'], negate: false },
        { kind: 'tag', ids: ['s'], negate: false },
        { kind: 'tag', ids: ['r'], negate: false },
      ],
      pinned: false,
    })
  })

  it('matches nothing for an unknown name, and excludes nothing for an excluded one', () => {
    expect(resolveSearch(parseSearch('book:Nowhere plan'), { books, tags })).toBeNull()
    expect(resolveSearch(parseSearch('-tag:nowhere plan'), { books, tags })).toEqual({
      text: [{ field: 'any', value: 'plan', negate: false }],
      sets: [],
      pinned: false,
    })
  })

  it('finds and excludes a notebook whose name is longer than a text value', () => {
    const long = `Archive ${'x'.repeat(MAX_TERM_CHARS + 42)}`
    const all = [...books, book('a', long)]
    expect(resolveSearch(parseSearch(`book:"${long}"`), { books: all, tags })?.sets).toEqual([
      { kind: 'book', ids: ['a'], negate: false },
    ])
    expect(resolveSearch(parseSearch(`-book:"${long}"`), { books: all, tags })?.sets).toEqual([
      { kind: 'book', ids: ['a'], negate: true },
    ])
    // Text values stay within what storage accepts.
    expect([...parseSearch(`title:"${long}"`)[0]!.value]).toHaveLength(MAX_TERM_CHARS)
  })

  it('narrows to the current view', () => {
    const view = (scope: SearchScope) => resolveSearch([any('x')], { books, tags, scope })
    expect(view({ bookId: 'w', filter: null })?.sets).toEqual([
      { kind: 'book', ids: ['w', 'p'], negate: false },
    ])
    expect(view({ bookId: null, filter: { kind: 'status', status: 'active' } })?.sets).toEqual([
      { kind: 'status', ids: ['active'], negate: false },
    ])
    expect(view({ bookId: 'h', filter: { kind: 'tag', tagId: 's' } })?.sets).toEqual([
      { kind: 'book', ids: ['h'], negate: false },
      { kind: 'tag', ids: ['s'], negate: false },
    ])
    expect(view({ bookId: null, filter: { kind: 'pinned' } })?.pinned).toBe(true)
  })
})

describe('highlighting', () => {
  it('collects the words to mark in titles and bodies', () => {
    expect(highlightTerms(parseSearch('plan title:week body:relay -draft tag:x'))).toEqual({
      title: ['plan', 'week'],
      body: ['plan', 'relay'],
    })
  })

  it('splits text into matched and unmatched runs, in any case', () => {
    expect(matchSegments('Weekly plan: PLANS', searchPattern(['plan', 'week']))).toEqual([
      { text: 'Week', match: true },
      { text: 'ly ', match: false },
      { text: 'plan', match: true },
      { text: ': ', match: false },
      { text: 'PLAN', match: true },
      { text: 'S', match: false },
    ])
    expect(matchSegments('a.b*c', searchPattern(['.b*']))).toEqual([
      { text: 'a', match: false },
      { text: '.b*', match: true },
      { text: 'c', match: false },
    ])
    expect(matchSegments('nothing', searchPattern([]))).toEqual([{ text: 'nothing', match: false }])
    expect(matchSegments('', searchPattern(['x']))).toEqual([])
  })
})

describe('bodyExcerpt', () => {
  it('cuts the body around the first term found, folding case beyond ASCII', () => {
    // "\u00c4rger" is the German word "anger" with a capital A umlaut.
    expect(bodyExcerpt('Kein \u00c4rger im Team', ['missing', '\u00e4RGER'])).toBe(
      'Kein \u00c4rger im Team',
    )
    const body = `${'x'.repeat(100)}needle${'y'.repeat(300)}`
    expect(bodyExcerpt(body, ['NEEDLE'])).toBe(`\u2026${'x'.repeat(40)}needle${'y'.repeat(114)}`)
    expect(bodyExcerpt(body, ['absent'])).toBeUndefined()
    expect(bodyExcerpt('', ['x'])).toBeUndefined()
  })

  // Shared with the Rust store (storage/tests.rs): long bodies, read only
  // around the place a word is found.
  it.each(EXCERPT_CASES)('$name', ({ parts, terms, excerpt }) => {
    expect(bodyExcerpt(excerptBody(parts), terms) ?? null).toBe(excerpt)
  })

  it('reads only a stretch of a long body, however long it is', (context) => {
    const line = 'lorem ipsum **dolor** sit [amet](https://devot.app/amet) consectetur\n'
    const body = `${line.repeat(800)}\nthe needle here\n\n${line.repeat(800)}`
    expect(bodyExcerpt(body, ['needle'])).toMatch(/amet consectetur the needle here lorem/)
    const start = performance.now()
    for (let i = 0; i < 100; i += 1) {
      bodyExcerpt(body, ['needle'])
      bodyExcerpt(body, ['absent'])
    }
    expectWithinBudget(context, performance.now() - start, EXCERPTS_BUDGET_MS)
  })
})

describe('full-text search on SQLite', () => {
  it('finds English and Chinese substrings in titles and bodies', async () => {
    const { notes } = setup()
    await note(notes, 'Relay design', 'WebSocket hibernation and backoff')
    await note(notes, SYNC_PLAN, `Yjs ${SYNC} notes`)
    await note(notes, 'Groceries', 'apples')
    expect(await titles(notes, 'hibernat')).toEqual(['Relay design'])
    expect(await titles(notes, 'RELAY')).toEqual(['Relay design'])
    expect(await titles(notes, SYNC_PLAN)).toEqual([SYNC_PLAN])
    // Two characters: below the trigram length, still found.
    expect(await titles(notes, SYNC)).toEqual([SYNC_PLAN])
    expect(await titles(notes, 'ap')).toEqual(['Groceries'])
  })

  it('needs every term to match, and matches quoted phrases exactly', async () => {
    const { notes } = setup()
    await note(notes, 'A', 'offline merge with Yjs')
    await note(notes, 'B', 'merge offline later')
    expect(await titles(notes, 'offline merge')).toEqual(['A', 'B'])
    expect(await titles(notes, '"offline merge"')).toEqual(['A'])
    expect(await titles(notes, 'offline yjs')).toEqual(['A'])
  })

  it('treats FTS syntax in the query as plain text', async () => {
    const { notes } = setup()
    await note(notes, 'Ops', 'use AND OR NOT carefully; a*b and "quotes" title:x')
    expect(await titles(notes, 'AND OR')).toEqual(['Ops'])
    expect(await titles(notes, 'a*b')).toEqual(['Ops'])
    expect(await titles(notes, '"quotes"')).toEqual(['Ops'])
    expect(await titles(notes, 'body:"NOT care"')).toEqual(['Ops'])
    expect(await notes.search('NEAR(')).toEqual([])
    expect(await notes.search('title:NEAR( body:"x" -"{a b}"')).toEqual([])
  })

  it('stays in step with edits, the trash, restores and purges', async () => {
    const { notes } = setup()
    const id = await note(notes, 'Draft', 'first words')
    expect(await titles(notes, 'first')).toEqual(['Draft'])

    await notes.setTitle(id, 'Final')
    await notes.flush()
    expect(await titles(notes, 'Draft')).toEqual([])
    expect(await titles(notes, 'Final')).toEqual(['Final'])

    await notes.trash(id)
    expect(await titles(notes, 'first')).toEqual([])
    await notes.restore(id)
    expect(await titles(notes, 'first')).toEqual(['Final'])
    await notes.trash(id)
    await notes.purge(id)
    expect(await titles(notes, 'first')).toEqual([])
  })

  it('sees edits that are not saved yet', async () => {
    const { notes } = setup()
    const id = await notes.create('Draft')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await notes.open(id)).state)
    const before = Y.encodeStateVector(doc)
    doc.getText(BODY).insert(0, 'first words')
    // Applied but not saved: the save waits for typing to pause.
    await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
    expect(await titles(notes, 'first')).toEqual(['Draft'])
  })

  it('returns nothing for an empty query', async () => {
    const { notes } = setup()
    await note(notes, 'Any', 'thing')
    expect(await notes.search('   ')).toEqual([])
  })
})

describe('qualifiers combined with full-text search on SQLite', () => {
  /**
   * Work (with the sub-notebook Projects) and "Weekly notes"; tags sync and
   * "to read"; statuses; one note in no notebook. Every note mentions "plan".
   */
  async function world() {
    const s = setup()
    const work = await s.books.create('Work', null)
    const projects = await s.books.create('Projects', work)
    const weekly = await s.books.create('Weekly notes', null)
    const ids = {
      relay: await note(s.notes, 'Relay plan', 'hibernation plan for the relay', work),
      editor: await note(s.notes, 'Editor plan', 'a plan with Yjs and the relay', projects),
      week: await note(s.notes, 'Week 41', 'plan the week; relay later', weekly),
      loose: await note(s.notes, 'Loose plan', `a ${SYNC} plan in no notebook`, null),
    }
    await s.tags.addToNote(ids.relay, 'sync')
    await s.tags.addToNote(ids.editor, 'Sync')
    await s.tags.addToNote(ids.week, 'to read')
    await s.notes.setStatus(ids.relay, 'active')
    await s.notes.setStatus(ids.week, 'on_hold')
    await s.notes.setPinned(ids.editor, true)
    await s.notes.flush()
    return { ...s, books: { work, projects, weekly }, ids, bookService: s.books }
  }

  it('narrows by notebook, including sub-notebooks, by name in any case', async () => {
    const { notes } = await world()
    expect(await titles(notes, 'plan book:work')).toEqual(['Editor plan', 'Relay plan'])
    expect(await titles(notes, 'plan book:Projects')).toEqual(['Editor plan'])
    expect(await titles(notes, 'book:"weekly NOTES"')).toEqual(['Week 41'])
    expect(await titles(notes, 'plan -book:Work')).toEqual(['Loose plan', 'Week 41'])
    expect(await titles(notes, 'plan book:Nowhere')).toEqual([])
    expect(await titles(notes, 'plan -book:Nowhere')).toHaveLength(4)
  })

  it('narrows by tag and status, by name or ID', async () => {
    const { notes } = await world()
    expect(await titles(notes, 'tag:SYNC')).toEqual(['Editor plan', 'Relay plan'])
    expect(await titles(notes, 'tag:"To Read" plan')).toEqual(['Week 41'])
    expect(await titles(notes, 'plan -tag:sync')).toEqual(['Loose plan', 'Week 41'])
    expect(await titles(notes, 'status:active')).toEqual(['Relay plan'])
    expect(await titles(notes, 'status:"On Hold"')).toEqual(['Week 41'])
    expect(await titles(notes, 'status:on_hold')).toEqual(['Week 41'])
    expect(await titles(notes, 'plan status:"no status"')).toEqual(['Editor plan', 'Loose plan'])
    expect(await titles(notes, 'plan -status:none')).toEqual(['Relay plan', 'Week 41'])
  })

  it('looks in the title or the body only, and excludes words and phrases', async () => {
    const { notes } = await world()
    expect(await titles(notes, 'title:relay')).toEqual(['Relay plan'])
    expect(await titles(notes, 'body:relay')).toEqual(['Editor plan', 'Relay plan', 'Week 41'])
    expect(await titles(notes, 'relay -title:relay')).toEqual(['Editor plan', 'Week 41'])
    expect(await titles(notes, 'plan -yjs')).toEqual(['Loose plan', 'Relay plan', 'Week 41'])
    expect(await titles(notes, 'plan -"relay later"')).toEqual([
      'Editor plan',
      'Loose plan',
      'Relay plan',
    ])
    // Short terms (scanned, not indexed) work in every position too.
    expect(await titles(notes, `title:41 -${SYNC}`)).toEqual(['Week 41'])
    expect(await titles(notes, `plan -body:${SYNC}`)).toHaveLength(3)
    expect(await titles(notes, `body:${SYNC}`)).toEqual(['Loose plan'])
  })

  it('combines everything', async () => {
    const { notes } = await world()
    expect(await titles(notes, 'book:Work tag:sync -status:active body:"plan with"')).toEqual([
      'Editor plan',
    ])
    expect(await titles(notes, 'plan book:Work status:active status:on_hold')).toEqual([])
    // Only qualifiers or only exclusions are queries too.
    expect(await titles(notes, '-relay')).toEqual(['Loose plan'])
  })

  it('searches within the current view: a notebook, a filter, or both', async () => {
    const { notes, books } = await world()
    expect(await titles(notes, 'plan', { bookId: books.work, filter: null })).toEqual([
      'Editor plan',
      'Relay plan',
    ])
    expect(await titles(notes, 'plan', { bookId: null, filter: { kind: 'pinned' } })).toEqual([
      'Editor plan',
    ])
    expect(
      await titles(notes, 'relay', { bookId: null, filter: { kind: 'status', status: 'on_hold' } }),
    ).toEqual(['Week 41'])
    const tagId = (await notes.list()).find((n) => n.title === 'Relay plan')!.tagIds[0]!
    expect(
      await titles(notes, 'plan', { bookId: books.work, filter: { kind: 'tag', tagId } }),
    ).toEqual(['Editor plan', 'Relay plan'])
    // Qualifiers narrow the view further.
    expect(
      await titles(notes, 'plan -book:Projects', { bookId: books.work, filter: null }),
    ).toEqual(['Relay plan'])
  })

  it('applies qualifiers before the result limit, so no match is dropped', async () => {
    const { notes, storage, books } = await world()
    // More notes than the limit match "plan"; only the qualifier tells them apart.
    const insert = storage.db.transaction(() => {
      for (let i = 0; i < SEARCH_LIMIT + 50; i += 1) {
        storage.db
          .prepare(
            `INSERT INTO notes (id, title, title_hlc, body_md, ydoc, book_id, book_hlc,
               status, status_hlc, pinned, pinned_hlc, created_at, updated_at)
             VALUES (?, ?, 'h', 'plan plan plan', x'00', NULL, '', 'none', '', 0, '', 1, ?)`,
          )
          .run(`0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`, `Filler ${i}`, 10 ** 13)
      }
    })
    insert()
    expect(await notes.search('plan')).toHaveLength(SEARCH_LIMIT)
    expect(await titles(notes, 'plan book:Work')).toEqual(['Editor plan', 'Relay plan'])
    expect(await titles(notes, 'plan', { bookId: books.weekly, filter: null })).toEqual(['Week 41'])
    expect(await titles(notes, 'plan tag:sync -status:active')).toEqual(['Editor plan'])
  })

  it('returns an excerpt around the first word found in the body', async () => {
    const { notes } = setup()
    const long = `${'lorem ipsum '.repeat(20)}the hibernation\n\n  plan ${'dolor '.repeat(40)}`
    await note(notes, 'Long', long)
    await note(notes, 'Short', 'one\nrelay   here')
    await note(notes, 'Title only', 'nothing relevant')
    const [hit] = await notes.search('hibernation')
    expect(hit?.excerpt).toMatch(/^\u2026.*ipsum the hibernation plan dolor/)
    expect([...(hit?.excerpt ?? '')].length).toBeLessThanOrEqual(161)
    expect((await notes.search('relay'))[0]?.excerpt).toBe('one relay here')
    await note(notes, 'German', 'Kein \u00c4rger im Team')
    expect((await notes.search('\u00e4rger'))[0]?.excerpt).toBe('Kein \u00c4rger im Team')
    expect((await notes.search('title:only'))[0]?.excerpt).toBeUndefined()
    expect((await notes.search('only'))[0]?.excerpt).toBeUndefined()
  })
})
