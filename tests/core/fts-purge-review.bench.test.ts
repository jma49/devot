import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService } from '../../src/core'
import { createSyncEngine } from '../../src/core/sync/engine'
import { encodeRecord, type NoteState } from '../../src/core/sync/records'
import { libraryBody } from '../../scripts/bench/fixtures'
import { summary } from '../../scripts/bench/large-notes'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const id = (n: number) => `0192a6f0-0000-7000-8000-${String(n).padStart(12, '0')}`
const hlc = '0000000000000030-0000-remote'

function seed(s: SqliteAdapter) {
  const insert = s.db.prepare(
    "INSERT INTO notes (id, title, title_hlc, body_md, ydoc, created_at, updated_at) VALUES (?, ?, '', ?, ?, 1, 1)",
  )
  s.db
    .transaction(() => {
      for (let n = 0; n < 10000; n++) {
        const doc = new Y.Doc()
        if (n < 100) doc.getText(BODY).insert(0, libraryBody(n))
        insert.run(id(n), `Note ${n}`, libraryBody(n), Y.encodeStateAsUpdate(doc))
        doc.destroy()
      }
      s.db.exec('UPDATE sync_records SET synced = edits')
    })
    .immediate()
  s.catchUpSearchIndex()
  void s.syncSetState('epoch', 'bench')
  s.db.exec("INSERT INTO notes_fts (notes_fts) VALUES ('optimize')")
}

function tombstone(n: number): NoteState {
  return {
    kind: 'note',
    id: id(n),
    purged: true,
    title: '',
    titleHlc: '',
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 0,
    updatedAt: 0,
    datesHlc: '',
    deletedAt: 30,
    deletedHlc: hlc,
    bodyHlc: '',
    tags: [],
    drawings: [],
    drawingsHlc: '',
    ydoc: new Uint8Array(),
  }
}

async function pull(s: SqliteAdapter) {
  let ready = false
  const records = Array.from({ length: 100 }, (_, n) => ({
    id: id(n),
    kind: 'record' as const,
    version: 1,
    tag: '',
    plaintext: encodeRecord(tombstone(n)),
  }))
  const engine = createSyncEngine({
    storage: s,
    sync: s,
    clock: createClock('local'),
    newId: createIdGenerator(),
    transport: {
      connect: async () => ({ time: Date.now(), epoch: 'bench', cursor: '', device: 'd' }),
      pull: async (since) => ({
        records: ready && since === '' ? records : [],
        next: ready ? '100' : since,
        more: false,
      }),
      push: async () => {
        throw new Error('E_UNEXPECTED_PUSH')
      },
      pushMany: async () => {
        throw new Error('E_UNEXPECTED_PUSH')
      },
      close: async () => {},
    },
  })
  engine.start()
  await engine.idle()
  ready = true
  try {
    const start = performance.now()
    await engine.syncNow()
    return performance.now() - start
  } finally {
    await engine.stop()
  }
}

it.runIf(process.env['DEVOT_PURGE_REVIEW_BENCH'] === '1')(
  'measures incoming purges and blank-draft discard',
  { timeout: 600_000 },
  async () => {
    const dir = tempDir('devot-purge-review-')
    const seedPath = join(dir, 'seed.sqlite')
    const initial = openSqliteAdapter(seedPath)
    seed(initial)
    initial.close()
    for (const kind of ['sync-100', 'blank-draft'] as const) {
      const times = []
      for (let run = -2; run < 20; run++) {
        const path = join(dir, `${kind}-${run}.sqlite`)
        copyFileSync(seedPath, path)
        const s = openSqliteAdapter(path)
        try {
          if (kind === 'sync-100') {
            times.push(await pull(s))
          } else {
            const notes = createNoteService({
              storage: s,
              clock: createClock('draft'),
              newId: createIdGenerator(),
              compact: false,
            })
            const draft = await notes.create('')
            s.catchUpSearchIndex()
            const start = performance.now()
            await notes.discardEmpty(draft)
            times.push(performance.now() - start)
          }
          expect(
            (
              s.db.prepare('SELECT count(*) AS n FROM notes WHERE purged_at IS NOT NULL').get() as {
                n: number
              }
            ).n,
          ).toBe(kind === 'sync-100' ? 100 : 1)
        } finally {
          s.close()
        }
      }
      console.log(kind, JSON.stringify(summary(times.slice(2))))
    }
  },
)
