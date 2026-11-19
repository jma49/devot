import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { libraryBody, sampleNote } from '../../scripts/bench/fixtures'
import { summary } from '../../scripts/bench/large-notes'
import { tempDir } from '../support/temp-dirs'

it.runIf(process.env['DEVOT_FTS_MIGRATION_BENCH'] === '1')(
  'measures rebuilding v31 libraries with the contentless migration',
  { timeout: 600_000 },
  async () => {
    const migrations = readdirSync('src-tauri/migrations')
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
    const memory = new Int32Array(new SharedArrayBuffer(8))
    const sampler = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads')
      const memory = new Int32Array(workerData)
      setInterval(() => {
        if (Atomics.load(memory, 0)) {
          const rss = Math.ceil(process.memoryUsage.rss() / 1024)
          Atomics.store(memory, 1, Math.max(Atomics.load(memory, 1), rss))
        }
      }, 1)
      parentPort.postMessage('ready')
    `,
      { eval: true, workerData: memory.buffer },
    )
    await new Promise<void>((resolve, reject) => {
      sampler.once('message', () => resolve())
      sampler.once('error', reject)
    })
    const results = []
    try {
      for (const kind of ['1000-notes', '10000-notes', '5MB-note'] as const) {
        const elapsed = []
        const sizes = []
        const peakRssDeltaKiB = []
        const count = kind === '5MB-note' ? 1 : Number.parseInt(kind, 10)
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
              for (let i = 0; i < count; i++) {
                insert.run(
                  `n${i}`,
                  `Note ${i}`,
                  kind === '5MB-note' ? sampleNote(5_000_000) : libraryBody(i),
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
            const baselineRssKiB = Math.ceil(process.memoryUsage.rss() / 1024)
            Atomics.store(memory, 1, baselineRssKiB)
            Atomics.store(memory, 0, 1)
            const start = performance.now()
            try {
              db.transaction(() =>
                db.exec(
                  migrations
                    .slice(31)
                    .map((file) => readFileSync(join('src-tauri/migrations', file), 'utf8'))
                    .join('\n'),
                ),
              )()
              elapsed.push(performance.now() - start)
            } finally {
              Atomics.store(memory, 0, 0)
            }
            peakRssDeltaKiB.push(
              Math.max(Atomics.load(memory, 1), Math.ceil(process.memoryUsage.rss() / 1024)) -
                baselineRssKiB,
            )
            db.exec("INSERT INTO notes_fts (notes_fts) VALUES ('optimize'); VACUUM;")
            sizes.push({ before, after: indexSize() })
            expect(
              (db.prepare('SELECT count(*) AS n FROM notes_fts').get() as { n: number }).n,
            ).toBe(count)
          } finally {
            db.close()
          }
        }
        results.push({
          kind,
          milliseconds: summary(elapsed),
          peakRssDeltaKiB: summary(peakRssDeltaKiB),
          sizes,
        })
      }
      console.log(JSON.stringify(results, null, 2))
    } finally {
      await sampler.terminate()
    }
  },
)
