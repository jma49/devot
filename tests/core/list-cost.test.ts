import Database from 'better-sqlite3'
import fc from 'fast-check'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  foldText,
  ftsQuery,
  indexable,
  NOTE_STATUSES,
  type NoteQuery,
  type NoteRecord,
  type NoteSummary,
  type SetCondition,
  type TextCondition,
} from '../../src/core'
import {
  LIST_SQL,
  openSqliteAdapter,
  SCHEMA_VERSION,
  searchStatement,
  type SqliteAdapter,
} from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Lists and searches read from covering indexes (migration 0014), never the note row, and must answer
// exactly as the statements they replace did.

const open: { close(): void }[] = []
afterEach(() => open.splice(0).forEach((db) => db.close()))

function sqlite(): SqliteAdapter {
  const storage = openSqliteAdapter(join(tempDir('devot-lists-'), 'devot.sqlite'))
  open.push(storage)
  return storage
}

type Params = Record<string, string | number>

/** Per sort in a plan, the top-level step it sits under ('' for a sort of the whole result). */
const sortsUnder = (db: Database.Database, sql: string, params: Params = {}) => {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as {
    id: number
    parent: number
    detail: string
  }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const top = (r: (typeof rows)[number]): string => {
    const parent = byId.get(r.parent)
    return parent ? top(parent) : r.parent === 0 && r.detail.includes('TEMP B-TREE') ? '' : r.detail
  }
  return rows.filter((r) => r.detail.includes('TEMP B-TREE')).map(top)
}

const plan = (db: Database.Database, sql: string, params: Params = {}) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[])
    .map((p) => p.detail)
    .join('\n')

const text = (field: TextCondition['field'], value: string, negate = false): TextCondition => ({
  field,
  value,
  negate,
})
const set = (kind: SetCondition['kind'], ids: string[], negate = false): SetCondition => ({
  kind,
  ids,
  negate,
})
const query = (
  texts: TextCondition[],
  sets: SetCondition[] = [],
  pinned: boolean | null = null,
): NoteQuery => ({
  text: texts,
  sets,
  pinned,
})

// The replaced statements, kept as the reference (rows and order) the new ones must match.
const BEFORE_LIST = `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, book_id AS bookId, status, pinned,
        (SELECT group_concat(nt.tag_id) FROM note_tags nt
           JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
          WHERE nt.note_id = notes.id AND nt.present = 1) AS tagIds,
          body_version AS bodyVersion
   FROM notes
   WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`
const BEFORE_TRASH = `SELECT id, title, deleted_at AS deletedAt, book_id AS bookId FROM notes
   WHERE deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at DESC, id DESC`
const TEXT_COLUMN = {
  any: 'n.title || char(10) || n.body_md',
  title: 'n.title',
  body: 'n.body_md',
} as const

function beforeSearch(db: Database.Database, q: NoteQuery, limit: number) {
  const params: Params = { limit }
  const param = (value: string) => {
    const name = `p${Object.keys(params).length}`
    params[name] = value
    return `@${name}`
  }
  const ranked = q.text.filter((t) => !t.negate && indexable(t.value))
  const where = ['n.deleted_at IS NULL', 'n.purged_at IS NULL']
  for (const t of q.text) {
    if (indexable(t.value)) {
      if (t.negate) {
        where.push(
          `n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ${param(ftsQuery([t]))})`,
        )
      }
    } else {
      where.push(
        `instr(lower(${TEXT_COLUMN[t.field]}), lower(${param(t.value)})) ${t.negate ? '=' : '>'} 0`,
      )
    }
  }
  for (const s of q.sets) {
    const ids = `(SELECT value FROM json_each(${param(JSON.stringify(s.ids))}))`
    if (s.kind === 'book') {
      where.push(
        s.negate ? `(n.book_id IS NULL OR n.book_id NOT IN ${ids})` : `n.book_id IN ${ids}`,
      )
    } else if (s.kind === 'status') {
      where.push(`n.status ${s.negate ? 'NOT IN' : 'IN'} ${ids}`)
    } else {
      where.push(
        `${s.negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM note_tags nt
           WHERE nt.note_id = n.id AND nt.present = 1 AND nt.tag_id IN ${ids})`,
      )
    }
  }
  if (q.pinned !== null) where.push(q.pinned ? 'n.pinned = 1' : 'n.pinned = 0')
  const sql = [
    `SELECT n.id, n.title, n.created_at AS createdAt, n.updated_at AS updatedAt, n.book_id AS bookId, n.status, n.pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = n.id AND nt.present = 1) AS tagIds,
            n.body_version AS bodyVersion
     FROM notes n`,
    ranked.length
      ? `JOIN notes_fts f ON f.rowid = n.rowid AND notes_fts MATCH ${param(ftsQuery(ranked))}`
      : '',
    `WHERE ${where.join('\n  AND ')}`,
    ranked.length ? 'ORDER BY bm25(notes_fts), n.updated_at DESC' : 'ORDER BY n.updated_at DESC',
    'LIMIT @limit',
  ].join('\n')
  return db.prepare(sql).all(params)
}

const summaries = (found: NoteSummary[]) =>
  found.map((note) => {
    const { excerpt: _, ...row } = note
    return row
  })
const asSummary = (row: Record<string, unknown>): Omit<NoteSummary, 'excerpt'> => ({
  id: row['id'] as string,
  title: row['title'] as string,
  createdAt: row['createdAt'] as number,
  updatedAt: row['updatedAt'] as number,
  bookId: row['bookId'] as string | null,
  status: row['status'] as NoteSummary['status'],
  pinned: row['pinned'] === 1,
  tagIds: row['tagIds'] ? (row['tagIds'] as string).split(',') : [],
  bodyVersion: row['bodyVersion'] as number,
})

const record = (id: string, fields: Partial<NoteRecord>): NoteRecord => ({
  id,
  title: '',
  titleHlc: '0000000000001-0000-test',
  bodyMd: '',
  ydoc: new Uint8Array([0]),
  bodyVersion: 0,
  bookId: null,
  bookHlc: '',
  status: 'none',
  statusHlc: '',
  pinned: false,
  pinnedHlc: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  deletedHlc: null,
  ...fields,
})

describe('lists and search read covering indexes', () => {
  it('reads the note list and the Trash from covering indexes, never a row', () => {
    const { db } = sqlite()
    const list = plan(db, LIST_SQL.notes)
    expect(list).toMatch(/^SCAN notes USING COVERING INDEX notes_list$/m)
    expect(list).not.toMatch(/TEMP B-TREE/)
    expect(plan(db, LIST_SQL.trash)).toMatch(/^SEARCH notes USING COVERING INDEX notes_trash /)
  })

  it('runs the same list statements as the Rust store', () => {
    const rust = readFileSync('src-tauri/src/storage/mod.rs', 'utf8')
    const statement = (name: string) =>
      new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(rust)?.[1] ?? ''
    const words = (sql: string) => sql.split(/\s+/).join(' ')
    expect(words(statement('NOTES_LIST_SQL'))).toBe(words(LIST_SQL.notes))
    expect(words(statement('TRASH_LIST_SQL'))).toBe(words(LIST_SQL.trash))
  })

  it('searches live notes in the list index: a ranked search joins its matches to it', () => {
    const { db } = sqlite()
    const explain = (q: NoteQuery) => {
      const { sql, params } = searchStatement(q, 200)
      return plan(db, sql, params)
    }
    for (const q of [
      query([text('any', 'snapshot')]),
      query(
        [text('title', 'plan'), text('body', 'relay', true)],
        [set('book', ['b1']), set('status', ['active'], true), set('tag', ['t1'])],
        true,
      ),
    ]) {
      // Deliberate trade-off: a ranked search walks the whole list index, so a word in one note costs O(notes)
      // (10,000 notes 0.7 ms, 50,000 about 2.5 ms), but a word in many notes costs less (17 ms against 38 ms).
      const ranked = explain(q)
      expect(ranked).toMatch(/MATERIALIZE hits/)
      expect(ranked).toMatch(/SCAN n USING COVERING INDEX notes_list/)
      expect(ranked).toMatch(/AUTOMATIC (PARTIAL )?COVERING INDEX \(rid=\?\)/)
      expect(ranked).not.toMatch(/INTEGER PRIMARY KEY|SCAN n$/m)
    }
    // Text under three characters reads the bodies of the ranked matches only, in rank order, so a page stops the scan (#48).
    const short = explain(query([text('any', 'snapshot'), text('body', 'zz', true)]))
    expect(short).toMatch(/MATERIALIZE ranked/)
    expect(short).toMatch(/SEARCH h USING AUTOMATIC (PARTIAL )?COVERING INDEX \(rid=\?\)/)
    expect(short).toMatch(
      /^SCAN n\nCORRELATED SCALAR SUBQUERY \d+\nSEARCH b USING INTEGER PRIMARY KEY/m,
    )
    const { sql, params } = searchStatement(
      query([text('any', 'snapshot'), text('body', 'zz', true)]),
      200,
    )
    expect(sortsUnder(db, sql, params)).toEqual(['MATERIALIZE ranked'])
    // Without ranked text the index gives the order and a page stops early.
    const sets = explain(query([text('any', 'zz', true)], [set('status', ['active'])]))
    expect(sets).toMatch(/^SCAN n USING INDEX notes_list$/m)
    expect(sets).not.toMatch(/TEMP B-TREE FOR ORDER BY/)
    const pinned = explain(query([], [set('book', ['b1'], true)], true))
    expect(pinned).toMatch(/^SCAN n USING COVERING INDEX notes_list$/m)
    expect(pinned).not.toMatch(/TEMP B-TREE FOR ORDER BY/)
  })
})

describe('lists and search answer as before', () => {
  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'ep', 'zeta']
  const library = fc.array(
    fc.record({
      title: fc.array(fc.constantFrom(...WORDS), { maxLength: 3 }),
      body: fc.array(fc.constantFrom(...WORDS, 'alpha beta', '\u540c\u6b65'), { maxLength: 12 }),
      bookId: fc.constantFrom(null, 'b1', 'b2'),
      status: fc.constantFrom(...NOTE_STATUSES),
      pinned: fc.boolean(),
      tags: fc.subarray(['t1', 't2', 'gone']),
      trashed: fc.boolean(),
      updatedAt: fc.nat(1000),
    }),
    { maxLength: 30 },
  )
  const condition = fc.record({
    field: fc.constantFrom('any' as const, 'title' as const, 'body' as const),
    value: fc.constantFrom(...WORDS, 'alpha beta', 'eta', 'a', '\u540c\u6b65'),
    negate: fc.boolean(),
  })
  const search = fc.record({
    text: fc.array(condition, { maxLength: 3 }),
    sets: fc.array(
      fc.oneof(
        fc.record({
          kind: fc.constant('book' as const),
          ids: fc.subarray(['b1', 'b2'], { minLength: 1 }),
          negate: fc.boolean(),
        }),
        fc.record({
          kind: fc.constant('status' as const),
          ids: fc.subarray([...NOTE_STATUSES], { minLength: 1 }),
          negate: fc.boolean(),
        }),
        fc.record({
          kind: fc.constant('tag' as const),
          ids: fc.subarray(['t1', 't2', 'gone'], { minLength: 1 }),
          negate: fc.boolean(),
        }),
      ),
      { maxLength: 2 },
    ),
    pinned: fc.constantFrom(true, false, null),
  })

  it('lists, finds and orders the same notes as the statements they replace', async () => {
    await fc.assert(
      fc.asyncProperty(
        library,
        fc.array(search, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 40 }),
        async (notes, queries, limit) => {
          const storage = sqlite()
          for (const [i, tag] of ['t1', 't2', 'gone'].entries()) {
            await storage.putTag({
              id: tag,
              name: tag,
              nameHlc: '0000000000001-0000-test',
              createdAt: 1,
              updatedAt: 1,
              deletedAt: tag === 'gone' ? 2 : null,
              deletedHlc: tag === 'gone' ? '0000000000002-0000-test' : null,
              color: null,
              colorHlc: '',
            })
            void i
          }
          // Distinct times, so the statements' order is total.
          const times = [...new Set(notes.map((n, i) => n.updatedAt * 100 + i))]
          for (const [i, n] of notes.entries()) {
            const id = `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
            await storage.putNote(
              record(id, {
                title: n.title.join(' '),
                bodyMd: n.body.join(' '),
                bookId: n.bookId,
                status: n.status,
                pinned: n.pinned,
                updatedAt: times[i]!,
                deletedAt: n.trashed ? times[i]! + 1 : null,
                deletedHlc: n.trashed ? '0000000000003-0000-test' : null,
              }),
            )
            for (const tag of n.tags) {
              await storage.putNoteTag({
                noteId: id,
                tagId: tag,
                present: true,
                hlc: '0000000000001-0000-test',
              })
            }
          }
          const { db } = storage
          expect(await storage.listNotes()).toEqual(
            (db.prepare(BEFORE_LIST).all() as Record<string, unknown>[]).map(asSummary),
          )
          expect(await storage.listTrash()).toEqual(db.prepare(BEFORE_TRASH).all())
          for (const q of queries) {
            const before = (beforeSearch(db, q, limit) as Record<string, unknown>[]).map(asSummary)
            expect(summaries(await storage.searchNotes(q, limit))).toEqual(before)
          }
        },
      ),
      { numRuns: 100 },
    )
  }, 120_000)

  it('reads the bodies of ranked matches only up to a page of results', async () => {
    // A page of 5 reads about 5 bodies, not 1,000; counting devot_fold calls counts the texts read.
    const storage = sqlite()
    storage.db.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        void storage.putNote(
          record(`n${String(i).padStart(4, '0')}`, {
            title: `note ${i}`,
            bodyMd: `merge \u{e9}a ${'word '.repeat(i % 7)}`,
            updatedAt: i,
          }),
        )
      }
    })()
    let reads = 0
    storage.db.function('devot_fold', { deterministic: true }, (value) => {
      reads += 1
      return typeof value === 'string' ? foldText(value) : value
    })
    const found = await storage.searchNotes(
      query([text('any', 'merge'), text('any', '\u{e9}a')]),
      5,
    )
    expect(found).toHaveLength(5)
    expect(reads).toBeLessThan(30)
  })

  it('orders notes saved at the same moment by ID, as the note list does', async () => {
    const storage = sqlite()
    for (const id of ['a', 'c', 'b']) {
      await storage.putNote(record(id, { title: `note ${id}`, bodyMd: 'same words', updatedAt: 5 }))
    }
    const ids = (found: { id: string }[]) => found.map((n) => n.id)
    expect(ids(await storage.listNotes())).toEqual(['c', 'b', 'a'])
    expect(ids(await storage.searchNotes(query([text('any', 'same')]), 10))).toEqual([
      'c',
      'b',
      'a',
    ])
    expect(ids(await storage.searchNotes(query([], [], null), 2))).toEqual(['c', 'b'])
  })
})

describe('schema v14', () => {
  it('upgrades a v13 database: its notes list, search and the Trash as before', async () => {
    const path = join(tempDir('devot-v13-'), 'devot.sqlite')
    const dir = 'src-tauri/migrations'
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
    const db = new Database(path)
    for (const [i, file] of files.slice(0, 13).entries()) {
      db.exec(readFileSync(join(dir, file), 'utf8'))
      db.pragma(`user_version = ${i + 1}`)
    }
    const insert = db.prepare(
      `INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at, deleted_hlc)
       VALUES (?, ?, '0000000000001-0000-test', ?, x'00', 1, ?, ?, ?)`,
    )
    insert.run('live', 'Live plan', 'the relay plan', 20, null, null)
    insert.run('old', 'Older', 'more words', 10, null, null)
    insert.run('gone', 'Trashed plan', 'plan', 30, 40, '0000000000002-0000-test')
    db.close()

    const storage = openSqliteAdapter(path)
    open.push(storage)
    expect(storage.schemaVersion()).toBe(SCHEMA_VERSION)
    const indexes = (storage.db.pragma('index_list(notes)') as { name: string }[]).map(
      (i) => i.name,
    )
    expect(indexes).toEqual(expect.arrayContaining(['notes_list', 'notes_trash']))
    expect(indexes).not.toContain('notes_live_by_updated')
    expect((await storage.listNotes()).map((n) => n.id)).toEqual(['live', 'old'])
    expect((await storage.listTrash()).map((n) => n.id)).toEqual(['gone'])
    expect((await storage.searchNotes(query([text('any', 'plan')]), 10)).map((n) => n.id)).toEqual([
      'live',
    ])
  })
})
