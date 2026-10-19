import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DAY_MS, formatHlc, loadActivity, type NoteRecord, type OffsetAt } from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTES = 10_000
const VERSIONS = 4
const BUDGET_MS = 250
// Body versions hold the note's Yjs state; a realistic size puts most of them
// in overflow pages, which counting must never read.
const STATE_BYTES = 8_000

const NOW = Date.UTC(2026, 9, 7, 12)
const UTC: OffsetAt = () => 0

function random(seed: number) {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}

let storage: SqliteAdapter

// Building the data is setup, not the measured work; give it room on a busy
// machine. The budget below is unchanged.
const SETUP_TIMEOUT_MS = 120_000

beforeAll(() => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  const rand = random(7)
  const state = new Uint8Array(STATE_BYTES).map(() => Math.floor(rand() * 256))
  const insert = storage.db.transaction(() => {
    for (let i = 0; i < NOTES; i += 1) {
      const id = `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
      const createdAt = NOW - Math.floor(rand() * 400) * DAY_MS
      const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'bench' })
      const note: NoteRecord = {
        id,
        title: `Note ${i}`,
        titleHlc: hlc,
        bodyMd: 'word '.repeat(100 + Math.floor(rand() * 400)),
        ydoc: state,
        bodyVersion: 0,
        bookId: null,
        bookHlc: '',
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        createdAt,
        updatedAt: NOW - Math.floor(rand() * 30) * DAY_MS,
        deletedAt: null,
        deletedHlc: null,
      }
      void storage.putNote(note)
      for (let v = 0; v < VERSIONS; v += 1) {
        void storage.putRevision({
          id: `0192a6f0-0000-7000-${9000 + v}-${String(i).padStart(12, '0')}`,
          noteId: id,
          kind: v === VERSIONS - 1 ? 'title' : 'body',
          at: NOW - Math.floor(rand() * 400) * DAY_MS,
          ydoc: v === VERSIONS - 1 ? null : state,
          length: v === VERSIONS - 1 ? null : Math.floor(rand() * 3000),
          value: v === VERSIONS - 1 ? `Note ${i}` : null,
        })
      }
    }
  })
  insert()
}, SETUP_TIMEOUT_MS)

afterAll(() => storage.close())

describe(`the activity heatmap over ${NOTES} notes`, () => {
  it(`is read and counted in under ${BUDGET_MS} ms`, async (context) => {
    const first = await loadActivity(storage, NOW, UTC)
    expect(first.total.activeDays).toBeGreaterThan(300)
    const times: number[] = []
    for (let i = 0; i < 7; i += 1) {
      const start = performance.now()
      await loadActivity(storage, NOW, UTC)
      times.push(performance.now() - start)
    }
    const ms = times.sort((a, b) => a - b)[3]!
    expectWithinBudget(context, ms, BUDGET_MS)
  })
})
