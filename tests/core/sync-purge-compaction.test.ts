import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

it.each([false, true])(
  'compacts synced purges once and recovers pending compaction on open: %s',
  async (reopen) => {
    const path = join(tempDir('devot-sync-purge-'), 'db.sqlite')
    const sql: string[] = []
    let s = openSqliteAdapter(path, { trace: (statement) => sql.push(statement) })
    const secret = 'qxjzvwkpfyb'
    try {
      s.db
        .prepare(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
      VALUES ('a', '', '', ?, x'00', 1, 1), ('b', '', '', ?, x'00', 1, 1), ('kept', '', '', 'orchard', x'00', 1, 1)`)
        .run(secret.repeat(400), secret.repeat(400))
      s.catchUpSearchIndex()
      sql.length = 0
      for (const id of ['a', 'b']) await s.syncPurge(id, 3, '0000000000000003-0000-remote', true)
      expect(sql.filter((statement) => statement.includes("VALUES ('optimize')"))).toEqual([])
      expect((await s.syncState())['searchCompactionPending']).toBe('1')
      if (reopen) {
        s.close()
        s = openSqliteAdapter(path, { trace: (statement) => sql.push(statement) })
      } else {
        await s.syncCompactPurges()
      }
      expect(sql.filter((statement) => statement.includes("VALUES ('optimize')"))).toHaveLength(1)
      expect((await s.syncState())['searchCompactionPending']).toBeUndefined()
      await s.syncCompactPurges()
      expect(sql.filter((statement) => statement.includes("VALUES ('optimize')"))).toHaveLength(1)
      s.db.exec("CREATE VIRTUAL TABLE temp.purge_vocab USING fts5vocab(main, notes_fts, 'row')")
      for (let i = 0; i < secret.length - 2; i++) {
        expect(
          s.db.prepare('SELECT term FROM purge_vocab WHERE term = ?').all(secret.slice(i, i + 3)),
        ).toEqual([])
      }
      expect(
        s.db.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?').all(secret),
      ).toEqual([])
      expect(
        s.db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'orchard'").all(),
      ).toHaveLength(1)
      s.db.pragma('wal_checkpoint(TRUNCATE)')
      const bytes = readFileSync(path)
      for (let i = 0; i < secret.length - 2; i++)
        expect(bytes.includes(secret.slice(i, i + 3))).toBe(false)
    } finally {
      s.close()
    }
  },
)

it('retains the pending marker if compaction fails and retries it', async () => {
  const s = openSqliteAdapter(join(tempDir('devot-sync-purge-'), 'db.sqlite'))
  try {
    s.db.exec(
      "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at) VALUES ('a', '', '', 'orchard', x'00', 1, 1)",
    )
    s.catchUpSearchIndex()
    await s.syncPurge('a', 3, '0000000000000003-0000-remote', true)
    s.db.exec(
      "CREATE TRIGGER refuse_compaction BEFORE DELETE ON sync_state WHEN old.key = 'searchCompactionPending' BEGIN SELECT RAISE(ABORT, 'E_TEST_COMPACT'); END",
    )
    await expect(s.syncCompactPurges()).rejects.toThrow('E_TEST_COMPACT')
    expect((await s.syncState())['searchCompactionPending']).toBe('1')
    s.db.exec('DROP TRIGGER refuse_compaction')
    await s.syncCompactPurges()
    expect((await s.syncState())['searchCompactionPending']).toBeUndefined()
  } finally {
    s.close()
  }
})
