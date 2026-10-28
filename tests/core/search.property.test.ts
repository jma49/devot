import fc from 'fast-check'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  matchSegments,
  searchPattern,
  MAX_BOOK_NAME_CHARS,
  MAX_SEARCH_TERMS,
  MAX_TAG_NAME_CHARS,
  MAX_TERM_CHARS,
  NOTE_STATUSES,
  UUID_V7,
  parseSearch,
  type NoteFilter,
  type NoteStatus,
  type SearchClause,
} from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Two Chinese characters ("sync"): below the trigram length, so storage scans for them.
const SYNC = '\u540c\u6b65'

const STATUS_NAMES: Record<NoteStatus, string[]> = {
  none: ['none', 'No Status', 'no-status'],
  active: ['active', 'Active', 'ACTIVE'],
  on_hold: ['on_hold', 'On Hold', 'on-hold'],
  completed: ['completed', 'Completed'],
  dropped: ['dropped', 'Dropped'],
}

const queryText = fc.string({
  unit: fc.oneof(
    {
      weight: 4,
      arbitrary: fc.constantFrom('"', "'", '-', ':', ' ', 'book', 'tag', 'status', 'x'),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        'title',
        'body',
        'On Hold',
        'pinned:',
        'bookId:',
        'tagId:',
        '0192a6f0-0000-7000-8000-0000000000b1',
        '\t',
        '\n',
        '\u3000',
      ),
    },
    { weight: 3, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 3 }) },
    // Lone surrogates: a query is any JavaScript string.
    { weight: 1, arbitrary: fc.constantFrom('\ud800', '\udc00') },
  ),
  maxLength: 60,
})

describe('parseSearch', () => {
  it('never throws, and always gives clauses storage accepts', () => {
    fc.assert(
      fc.property(fc.oneof(queryText, fc.string({ unit: 'binary' })), (query) => {
        const clauses = parseSearch(query)
        expect(clauses.length).toBeLessThanOrEqual(MAX_SEARCH_TERMS)
        for (const c of clauses) {
          expect(c.value.length).toBeGreaterThan(0)
          const most =
            c.field === 'book'
              ? MAX_BOOK_NAME_CHARS
              : c.field === 'tag'
                ? MAX_TAG_NAME_CHARS
                : MAX_TERM_CHARS
          expect([...c.value].length).toBeLessThanOrEqual(most)
          expect(c.value.trim()).toBe(c.value)
          expect(() => encodeURIComponent(c.value)).not.toThrow()
          expect(c.field !== 'status' || NOTE_STATUSES.some((st) => st === c.value)).toBe(true)
          expect(c.field !== 'pinned' || c.value === 'true' || c.value === 'false').toBe(true)
          expect((c.field !== 'bookId' && c.field !== 'tagId') || UUID_V7.test(c.value)).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('reads back any clauses written with quotes', () => {
    const value = fc
      .string({ unit: 'binary', minLength: 1, maxLength: MAX_TERM_CHARS })
      .filter((v) => v.trim() === v && v !== '' && !v.includes('"'))
    const clause = fc.oneof(
      fc.record({
        field: fc.constantFrom('any', 'title', 'body', 'book', 'tag'),
        value,
        negate: fc.boolean(),
      }),
      fc
        .record({
          status: fc.constantFrom(...NOTE_STATUSES),
          pick: fc.nat(),
          negate: fc.boolean(),
        })
        .map(({ status, pick, negate }) => ({
          field: 'status' as const,
          value: status,
          written: STATUS_NAMES[status][pick % STATUS_NAMES[status].length]!,
          negate,
        })),
    )
    fc.assert(
      fc.property(fc.array(clause, { maxLength: MAX_SEARCH_TERMS }), (clauses) => {
        const query = clauses
          .map((c) => {
            const shown = 'written' in c ? c.written : c.value
            return `${c.negate ? '-' : ''}${c.field === 'any' ? '' : `${c.field}:`}"${shown}"`
          })
          .join(' ')
        const expected: SearchClause[] = clauses.map((c) => ({
          field: c.field,
          value: c.value,
          negate: c.negate,
        }))
        expect(parseSearch(query)).toEqual(expected)
      }),
      { numRuns: 500 },
    )
  })
})

describe('matchSegments', () => {
  it('splits text into alternating runs that put it back together', () => {
    fc.assert(
      fc.property(
        queryText,
        fc.array(fc.oneof(queryText, fc.constantFrom('x', 'X', '.*', '(')), { maxLength: 4 }),
        (text, terms) => {
          const segments = matchSegments(text, searchPattern(terms))
          expect(segments.map((s) => s.text).join('')).toBe(text)
          expect(segments.every((s) => s.text !== '')).toBe(true)
          expect(segments.every((s, i) => i === 0 || s.match !== segments[i - 1]!.match)).toBe(true)
        },
      ),
      { numRuns: 1000 },
    )
  })
})

// Cased non-ASCII words too, short ones among them ("ém" is scanned, not looked up in the trigram index).
// No sigma or dotted capital I: their lower case depends on context in toLowerCase (storage folds per character; tests/support/folds.json).
const WORDS = [
  'plan',
  'relay',
  'yjs',
  'ab',
  SYNC,
  'week',
  '\u00c9mile',
  '\u00e9m',
  '\u00dcnal',
  '\u00c5\u00c4',
  '\u0416\u0443\u043a',
]
const BOOKS = ['Alpha', 'Beta', 'Weekly notes'] as const // Beta is inside Alpha
const TAGS = ['red', 'to read'] as const

interface ModelNote {
  title: string
  body: string
  book: number | null
  tags: number[]
  status: NoteStatus
  pinned: boolean
}

const words = (min: number, max: number) =>
  fc.array(fc.constantFrom(...WORDS), { minLength: min, maxLength: max }).map((w) => w.join(' '))
const modelNote: fc.Arbitrary<ModelNote> = fc.record({
  title: words(1, 2),
  body: words(0, 5),
  book: fc.option(fc.integer({ min: 0, max: BOOKS.length - 1 })),
  tags: fc.subarray([0, 1]),
  status: fc.constantFrom(...NOTE_STATUSES),
  pinned: fc.boolean(),
})

const anyCase = (name: string) =>
  fc.constantFrom(name, name.toUpperCase(), name.toLowerCase(), `${name[0]}${name.slice(1)}`)
const SHORT_TERMS = [
  '\u00e9m',
  '\u00c9M',
  '\u00dcn',
  '\u00fcN',
  '\u00e5\u00e4',
  '\u00c5\u00c4',
  '\u0436\u0443',
  '\u0416\u0423',
]
const queryClause = fc.oneof(
  fc.record({
    field: fc.constantFrom('any', 'title', 'body'),
    value: fc.constantFrom(...SHORT_TERMS),
    negate: fc.boolean(),
  }),
  fc.record({
    field: fc.constantFrom('any', 'title', 'body'),
    value: fc.oneof(fc.constantFrom(...WORDS).chain(anyCase), words(2, 2)),
    negate: fc.boolean(),
  }),
  fc.record({
    field: fc.constant('book'),
    value: fc.oneof(...BOOKS.map(anyCase), fc.constant('Nowhere')),
    negate: fc.boolean(),
  }),
  fc.record({
    field: fc.constant('tag'),
    value: fc.oneof(...TAGS.map(anyCase), fc.constant('blue')),
    negate: fc.boolean(),
  }),
  fc.record({
    field: fc.constant('status'),
    value: fc.constantFrom(...Object.values(STATUS_NAMES).flat()),
    negate: fc.boolean(),
  }),
  fc.record({
    field: fc.constant('pinned'),
    value: fc.constantFrom('true', 'false', 'TRUE', 'Yes', 'no', '1', '0'),
    negate: fc.boolean(),
  }),
)
const scope = fc.record({
  book: fc.option(fc.integer({ min: 0, max: BOOKS.length - 1 })),
  filter: fc.option(
    fc.oneof(
      fc.constant({ kind: 'pinned' as const }),
      fc.record({
        kind: fc.constant('status' as const),
        status: fc.constantFrom(...NOTE_STATUSES),
      }),
      fc.record({ kind: fc.constant('tag' as const), tag: fc.integer({ min: 0, max: 1 }) }),
    ),
  ),
})

function matches(n: ModelNote, c: SearchClause): boolean {
  const has = (text: string) => text.toLowerCase().includes(c.value.toLowerCase())
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  switch (c.field) {
    case 'any':
      return has(n.title) || has(n.body)
    case 'title':
      return has(n.title)
    case 'body':
      return has(n.body)
    case 'book': {
      const names = n.book === null ? [] : [BOOKS[n.book]!, ...(n.book === 1 ? [BOOKS[0]] : [])]
      return names.some((name) => same(name, c.value))
    }
    case 'tag':
      return n.tags.some((t) => same(TAGS[t]!, c.value))
    case 'status':
      return n.status === c.value
    case 'pinned':
      return n.pinned === (c.value === 'true')
    case 'bookId':
    case 'tagId':
      // IDs are not known when queries are drawn; the unit tests cover them.
      throw new Error('E_TEST_UNEXPECTED_FIELD')
  }
}

describe('search on SQLite', () => {
  it('finds exactly the notes the query rules describe, in any view', async () => {
    const dir = tempDir('devot-search-prop-')
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(modelNote, { minLength: 1, maxLength: 8 }),
        fc.array(fc.tuple(fc.array(queryClause, { minLength: 1, maxLength: 4 }), scope), {
          minLength: 1,
          maxLength: 6,
        }),
        async (model, queries) => {
          const storage = openSqliteAdapter(join(dir, `run-${run++}.sqlite`))
          try {
            const clock = createClock('mac')
            const newId = createIdGenerator()
            const notes = createNoteService({ storage, clock, newId, saveDelayMs: 1 })
            const books = createBookService({ storage, clock, newId })
            const tags = createTagService({ storage, clock, newId })
            const alpha = await books.create(BOOKS[0], null)
            const bookIds = [
              alpha,
              await books.create(BOOKS[1], alpha),
              await books.create(BOOKS[2], null),
            ]
            const tagIds: string[] = []
            const ids: string[] = []
            for (const n of model) {
              const id = await notes.create(n.title, n.book === null ? null : bookIds[n.book])
              await notes.setBody(id, n.body)
              await notes.setStatus(id, n.status)
              await notes.setPinned(id, n.pinned)
              for (const t of n.tags) tagIds[t] = await tags.addToNote(id, TAGS[t]!)
              ids.push(id)
            }
            await notes.flush()

            for (const [clauses, view] of queries) {
              const query = clauses
                .map(
                  (c) =>
                    `${c.negate ? '-' : ''}${c.field === 'any' ? '' : `${c.field}:`}"${c.value}"`,
                )
                .join(' ')
              const parsed = parseSearch(query)
              let filter: NoteFilter | null = null
              if (view.filter?.kind === 'pinned') filter = view.filter
              if (view.filter?.kind === 'status') filter = view.filter
              if (view.filter?.kind === 'tag') {
                const tagId = tagIds[view.filter.tag]
                // A filter on a tag no note has: the sidebar would not show it.
                if (tagId) filter = { kind: 'tag', tagId }
              }
              const inView = (n: ModelNote) => {
                if (
                  view.book !== null &&
                  n.book !== view.book &&
                  !(view.book === 0 && n.book === 1)
                )
                  return false
                if (filter?.kind === 'pinned') return n.pinned
                if (filter?.kind === 'status') return n.status === filter.status
                if (filter?.kind === 'tag')
                  return n.tags.includes(view.filter?.kind === 'tag' ? view.filter.tag : -1)
                return true
              }
              const expected = model
                .flatMap((n, i) =>
                  inView(n) && parsed.every((c) => matches(n, c) !== c.negate) ? [ids[i]!] : [],
                )
                .sort()
              const { found } = await notes.search(query, {
                bookId: view.book === null ? null : bookIds[view.book]!,
                filter,
              })
              expect({ query, ids: found.map((n) => n.id).sort() }).toEqual({
                query,
                ids: expected,
              })
            }
          } finally {
            storage.close()
          }
        },
      ),
      { numRuns: 40 },
    )
  }, 60_000)
})
