import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { libraryBody, sampleNote } from '../../scripts/bench/fixtures'
import { summary } from '../../scripts/bench/large-notes'
import { tempDir } from '../support/temp-dirs'

it.runIf(process.env['DEVOT_FTS_MIGRATION_BENCH'] === '1')(
  'measures rebuilding v31 libraries with the contentless migration',
  { timeout: 600_000 },
  () => {
    const migrations = readdirSync('src-tauri/migrations')
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
    const results = []
    for (const kind of ['10000-notes', '5MB-note'] as const) {
      const elapsed = []
      const sizes = []
      for (let run = 0; run < 5; run++) {
        const db = new Database(join(tempDir('devot-fts-migration-'), 'db.sqlite'))
        try {
          db.pragma('journal_mode = WAL')
          db.pragma('synchronous = FULL')
          db.pragma('secure_delete = ON')
          for (const file of migrations.slice(0, 31))
            db.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'))
          const insert =
            db.prepare(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at)
            VALUES (?, ?, '', ?, x'00', 1, 1)`)
          db.transaction(() => {
            for (let i = 0; i < (kind === '10000-notes' ? 10000 : 1); i++) {
              insert.run(
                `n${i}`,
                `Note ${i}`,
                kind === '10000-notes' ? libraryBody(i) : sampleNote(5_000_000),
              )
            }
            db.exec(`INSERT INTO notes_fts (rowid, title, body_md) SELECT rowid, title, body_md FROM notes;
              DELETE FROM search_stale;
              INSERT INTO notes_fts (notes_fts) VALUES ('optimize');`)
          })()
          const indexSize = () =>
            (
              db
                .prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name GLOB 'notes_fts_*'")
                .get() as { bytes: number }
            ).bytes
          const before = indexSize()
          const start = performance.now()
          db.transaction(() =>
            db.exec(
              readFileSync('src-tauri/migrations/0032_search_contentless_delete.sql', 'utf8'),
            ),
          )()
          elapsed.push(performance.now() - start)
          db.exec("INSERT INTO notes_fts (notes_fts) VALUES ('optimize'); VACUUM;")
          sizes.push({ before, after: indexSize() })
          expect((db.prepare('SELECT count(*) AS n FROM notes_fts').get() as { n: number }).n).toBe(
            kind === '10000-notes' ? 10000 : 1,
          )
        } finally {
          db.close()
        }
      }
      results.push({ kind, milliseconds: summary(elapsed), sizes })
    }
    console.log(JSON.stringify(results, null, 2))
  },
)
