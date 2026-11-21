// A save only marks its note stale for search (schema v29); a search and a purge catch the index up
// first, so they read what the notes hold now.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { NoteRecord } from '../../src/core'
import { CATCH_UP_SQL, openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function sqlite(path = join(tempDir('devot-search-catch-up-'), 'devot.sqlite')) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  return storage
}

function note(id: string, title: string, bodyMd: string, bodyVersion = 0): NoteRecord {
  return {
    id,
    title,
    titleHlc: `${String(bodyVersion + 1).padStart(13, '0')}-0000-test`,
    bodyMd,
    ydoc: new Uint8Array([1]),
    bodyVersion,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 1,
    updatedAt: 1 + bodyVersion,
    deletedAt: null,
    deletedHlc: null,
  }
}

const words = (term: string) => ({
  text: [{ field: 'any' as const, value: term, negate: false }],
  sets: [],
  pinned: null,
})

const stale = (s: SqliteAdapter) =>
  (s.db.prepare('SELECT count(*) AS n FROM search_stale').get() as { n: number }).n
const indexBlocks = (s: SqliteAdapter) =>
  s.db.prepare('SELECT id, block FROM notes_fts_data ORDER BY id').all()
const found = async (s: SqliteAdapter, term: string) =>
  (await s.searchNotes(words(term), 10)).map((n) => n.id)

describe('the search index', () => {
  it('upgrades v31 notes and stale rows without retaining deleted or old terms', async () => {
    const path = join(tempDir('devot-search-upgrade-'), 'devot.sqlite')
    const legacy = new Database(path)
    try {
      for (const file of readdirSync('src-tauri/migrations')
        .filter((f) => /^00(0\d|[12]\d|3[01])_.*\.sql$/.test(f))
        .sort()) {
        legacy.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'))
      }
      legacy.pragma('user_version = 31')
      legacy.exec(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
        VALUES ('old', 'Original', '', 'orchard', x'00', 1, 1),
               ('edited', 'Edited', '', 'obsolete', x'00', 1, 1),
               ('deleted', 'Deleted', '', 'vanished', x'00', 1, 1);
        INSERT INTO notes_fts (rowid, title, body_md) SELECT rowid, title, body_md FROM notes;
        DELETE FROM search_stale;
        UPDATE notes SET body_md = 'snapshot' WHERE id = 'edited';
        DELETE FROM notes WHERE id = 'deleted';`)
    } finally {
      legacy.close()
    }
    const s = sqlite(path)
    expect(stale(s)).toBe(0)
    expect(await found(s, 'orchard')).toEqual(['old'])
    expect(await found(s, 'snapshot')).toEqual(['edited'])
    expect(await found(s, 'obsolete')).toEqual([])
    expect(await found(s, 'vanished')).toEqual([])
    expect(s.db.prepare('PRAGMA table_info(search_stale)').all()).toEqual([
      expect.objectContaining({ name: 'rowid' }),
    ])
    expect(s.db.prepare('SELECT title, body_md FROM notes_fts LIMIT 1').get()).toEqual({
      title: null,
      body_md: null,
    })
  })

  it('runs the same catch-up statements as the Rust store', () => {
    const rust = readFileSync('src-tauri/src/storage/search.rs', 'utf8')
    const block = /const CATCH_UP_SQL: \[&str; 3\] = \[([\s\S]*?)\];/.exec(rust)?.[1] ?? ''
    const statements = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
    const spaced = (sql: string) => sql.split(/\s+/).join(' ').trim()
    expect(statements.map(spaced)).toEqual(CATCH_UP_SQL.map(spaced))
  })

  it('is left alone by a save and caught up by the next search', async () => {
    const s = sqlite()
    await s.putNote(note('plan', 'Launch plan', 'The relay goes first.'))
    expect(await found(s, 'relay')).toEqual(['plan'])
    const indexed = indexBlocks(s)

    await s.putNote(note('plan', 'Launch day', 'Snapshot first.', 1))
    expect(indexBlocks(s)).toEqual(indexed)
    expect(stale(s)).toBe(1)

    expect(await found(s, 'snapshot')).toEqual(['plan'])
    expect(await found(s, 'relay')).toEqual([])
    expect(await found(s, 'day')).toEqual(['plan'])
    expect(stale(s)).toBe(0)
    s.db.exec(`INSERT INTO notes_fts (notes_fts) VALUES ('integrity-check')`)
  })

  it('is caught up only by a search that reads it', async () => {
    const s = sqlite()
    await s.putNote(note('plan', 'Launch plan', 'The relay goes first.'))
    const short = { ...words('re'), pinned: false }
    expect((await s.searchNotes(short, 10)).map((n) => n.id)).toEqual(['plan'])
    expect(stale(s)).toBe(1)

    const without = {
      ...words('orbit'),
      text: [{ field: 'any' as const, value: 'orbit', negate: true }],
    }
    expect((await s.searchNotes(without, 10)).map((n) => n.id)).toEqual(['plan'])
    expect(stale(s)).toBe(0)
  })

  it('stays whole when an indexed note with no text is purged', async () => {
    const s = sqlite()
    await s.putNote({ ...note('empty', '', ''), deletedAt: 5, deletedHlc: '5' })
    await s.putNote(note('kept', 'Kept', 'Kept'))
    s.catchUpSearchIndex()
    s.db.exec(`INSERT INTO notes_fts (notes_fts) VALUES ('integrity-check')`)
    await s.purgeNote('empty', 6, '0000000000006-0000-test')
    expect(stale(s)).toBe(0)
    s.db.exec(`INSERT INTO notes_fts (notes_fts) VALUES ('integrity-check')`)
    expect(await found(s, 'kept')).toEqual(['kept'])
  })

  it('loses the text it held for a purged note, from the file too, after later edits', async () => {
    const path = join(tempDir('devot-search-catch-up-'), 'devot.sqlite')
    const s = sqlite(path)
    const indexed = 'Qxjzvwkpfyb '.repeat(400)
    const edited = 'Mbvtrqzhwkd '.repeat(400)
    await s.putNote(note('gone', 'Gone', indexed))
    await s.putNote(note('kept', 'Kept', 'Kept'))
    expect(await found(s, 'qxjzvwkpfyb')).toEqual(['gone'])
    await s.putNote({ ...note('gone', 'Gone', edited, 1), deletedAt: 5, deletedHlc: '5' })
    await s.purgeNote('gone', 6, '0000000000006-0000-test')
    expect(stale(s)).toBe(0)
    expect(await found(s, 'kept')).toEqual(['kept'])
    s.db.exec(`INSERT INTO notes_fts (notes_fts) VALUES ('integrity-check')`)
    s.db.exec(`CREATE VIRTUAL TABLE temp.purge_vocab USING fts5vocab(main, notes_fts, 'row')`)
    const terms = (s.db.prepare('SELECT term FROM purge_vocab').all() as { term: string }[]).map(
      (row) => row.term,
    )
    for (const word of ['qxjzvwkpfyb', 'mbvtrqzhwkd']) {
      expect(await found(s, word)).toEqual([])
      for (let i = 0; i < word.length - 2; i++) expect(terms).not.toContain(word.slice(i, i + 3))
    }
    s.db.pragma('wal_checkpoint(TRUNCATE)')
    s.close()
    open.splice(0)
    const bytes = readFileSync(path)
    for (const word of ['Qxjzvwkpfyb', 'Mbvtrqzhwkd']) {
      expect(bytes.includes(word)).toBe(false)
      const lower = word.toLowerCase()
      const left = [...Array(lower.length - 2).keys()]
        .map((i) => lower.slice(i, i + 3))
        .filter((trigram) => bytes.includes(trigram))
      expect(left).toEqual([])
    }
  })
})
