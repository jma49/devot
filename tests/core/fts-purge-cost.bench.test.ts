import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { libraryBody, sampleNote } from '../../scripts/bench/fixtures'
import { summary } from '../../scripts/bench/large-notes'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

it.runIf(process.env['DEVOT_FTS_PURGE_BENCH'] === '1')(
  'measures single purges and the app empty-Trash path on indexed libraries',
  { timeout: 600_000 },
  async () => {
    const results = []
    for (const kind of ['one-of-10000', '5MB-note', 'trash-100-of-10000'] as const) {
      const dir = tempDir('devot-purge-cost-')
      const seed = join(dir, 'seed.sqlite')
      const initial = openSqliteAdapter(seed)
      try {
        const put = initial.db
          .prepare(`INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at, deleted_at, deleted_hlc)
          VALUES (?, ?, '', ?, x'00', 1, 1, ?, ?)`)
        initial.db
          .transaction(() => {
            const count = kind === '5MB-note' ? 2 : 10000
            const trashed = kind === 'trash-100-of-10000' ? 100 : 1
            for (let i = 0; i < count; i++) {
              put.run(
                `n${i}`,
                `Note ${i}`,
                kind === '5MB-note' && i === 0 ? sampleNote(5_000_000) : libraryBody(i),
                i < trashed ? 2 : null,
                i < trashed ? '0000000000002-0000-bench' : null,
              )
            }
          })
          .immediate()
        initial.catchUpSearchIndex()
        initial.db.exec("INSERT INTO notes_fts (notes_fts) VALUES ('optimize')")
        initial.db.pragma('wal_checkpoint(TRUNCATE)')
      } finally {
        initial.close()
      }
      const times = []
      for (let run = -2; run < 20; run++) {
        const path = join(dir, `run-${run}.sqlite`)
        copyFileSync(seed, path)
        const storage = openSqliteAdapter(path)
        const notes = createNoteService({
          storage,
          clock: createClock('purgebench'),
          newId: createIdGenerator(),
          compact: false,
        })
        try {
          let purged = 1
          const start = performance.now()
          if (kind === 'trash-100-of-10000') {
            purged = await notes.emptyTrash()
          } else {
            await notes.purge('n0')
          }
          times.push(performance.now() - start)
          expect(purged).toBe(kind === 'trash-100-of-10000' ? 100 : 1)
          expect(await storage.listTrash()).toEqual([])
          expect(
            (
              storage.db
                .prepare('SELECT count(*) AS n FROM notes WHERE purged_at IS NOT NULL')
                .get() as { n: number }
            ).n,
          ).toBe(kind === 'trash-100-of-10000' ? 100 : 1)
        } finally {
          storage.close()
        }
      }
      results.push({ kind, milliseconds: summary(times.slice(2)) })
    }
    console.log(JSON.stringify(results, null, 2))
  },
)
