import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

it.each([false, true])(
  'never-typed draft discard skips optimization, indexed: %s',
  async (indexed) => {
    const sql: string[] = []
    const s = openSqliteAdapter(join(tempDir('devot-blank-purge-'), 'db.sqlite'), {
      trace: (statement) => sql.push(statement),
    })
    const notes = createNoteService({
      storage: s,
      clock: createClock('draft'),
      newId: createIdGenerator(),
      compact: false,
    })
    try {
      const id = await notes.create('')
      if (indexed) s.catchUpSearchIndex()
      const sizes = s.db
        .prepare(
          'SELECT hex(sz) AS sz FROM notes_fts_docsize WHERE id = (SELECT rowid FROM notes WHERE id = ?)',
        )
        .all(id)
      expect(sizes).toEqual(indexed ? [{ sz: '0000' }] : [])
      sql.length = 0
      await notes.discardEmpty(id)
      expect(await s.getNote(id)).toBeNull()
      expect(sql.filter((statement) => statement.includes("VALUES ('optimize')"))).toEqual([])
    } finally {
      s.close()
    }
  },
)

it.each([false, true])(
  'removes old indexed text from a typed-then-cleared draft, caught up: %s',
  async (caughtUp) => {
    const path = join(tempDir('devot-blank-purge-'), 'db.sqlite')
    const sql: string[] = []
    const s = openSqliteAdapter(path, { trace: (statement) => sql.push(statement) })
    const notes = createNoteService({
      storage: s,
      clock: createClock('draft'),
      newId: createIdGenerator(),
      compact: false,
    })
    const secret = 'qxjzvwkpfyb'
    try {
      const id = await notes.create('')
      await notes.setBody(id, secret.repeat(400))
      await notes.flush()
      s.catchUpSearchIndex()
      await notes.setBody(id, '')
      await notes.flush()
      if (caughtUp) s.catchUpSearchIndex()
      sql.length = 0
      await notes.discardEmpty(id)
      expect(await s.getNote(id)).toBeNull()
      expect(sql.filter((statement) => statement.includes("VALUES ('optimize')"))).toHaveLength(1)
      s.db.exec("CREATE VIRTUAL TABLE temp.purge_vocab USING fts5vocab(main, notes_fts, 'row')")
      expect(
        s.db.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?').all(secret),
      ).toEqual([])
      for (let i = 0; i < secret.length - 2; i++) {
        expect(
          s.db.prepare('SELECT term FROM purge_vocab WHERE term = ?').all(secret.slice(i, i + 3)),
        ).toEqual([])
      }
      expect(s.db.prepare('SELECT rowid FROM search_postings_pending').all()).toEqual([])
      s.db.pragma('wal_checkpoint(TRUNCATE)')
      const bytes = readFileSync(path)
      for (let i = 0; i < secret.length - 2; i++)
        expect(bytes.includes(secret.slice(i, i + 3))).toBe(false)
    } finally {
      s.close()
    }
  },
)

it('conservatively compacts indexed history left by v32 even when docsize is zero', async () => {
  const path = join(tempDir('devot-blank-upgrade-'), 'db.sqlite')
  const legacy = new Database(path)
  try {
    for (const file of readdirSync('src-tauri/migrations')
      .filter((f) => Number.parseInt(f, 10) <= 32)
      .sort()) {
      legacy.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'))
    }
    legacy.exec(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
      VALUES ('draft', '', '', 'qxjzvwkpfyb', x'00', 1, 1);
      INSERT INTO notes_fts (rowid, title, body_md) SELECT rowid, title, body_md FROM notes;
      DELETE FROM search_stale;
      UPDATE notes SET body_md = '' WHERE id = 'draft';
      DELETE FROM notes_fts WHERE rowid = 1;
      INSERT INTO notes_fts (rowid, title, body_md) VALUES (1, '', '');
      DELETE FROM search_stale;
      PRAGMA user_version = 32;`)
  } finally {
    legacy.close()
  }
  const sql: string[] = []
  const s = openSqliteAdapter(path, { trace: (statement) => sql.push(statement) })
  try {
    expect(s.db.prepare('SELECT hex(sz) AS sz FROM notes_fts_docsize WHERE id = 1').get()).toEqual({
      sz: '0000',
    })
    sql.length = 0
    await s.purgeNote('draft', 3, '0000000000000003-0000-test')
    expect(sql.filter((statement) => statement.includes("VALUES ('optimize')"))).toHaveLength(1)
    s.db.pragma('wal_checkpoint(TRUNCATE)')
    expect(readFileSync(path).includes('qxj')).toBe(false)
  } finally {
    s.close()
  }
})
