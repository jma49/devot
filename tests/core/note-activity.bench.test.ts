import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  activitySince,
  buildStrips,
  DAY_MS,
  formatHlc,
  MAX_BODY_IDS,
  stripStart,
  type NoteRecord,
  type OffsetAt,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTES = 10_000
const VERSIONS = 20
/** A tall window shows about this many rows; the list asks for those only. */
const VISIBLE = 60
const BUDGET_MS = 10
// Body versions hold the note's Yjs state; a realistic size puts most of them in overflow pages, which counting must never read.
const STATE_BYTES = 8_000

const NOW = Date.UTC(2026, 9, 7, 12)
const UTC: OffsetAt = () => 0

function random(seed: number) {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}

const noteId = (i: number) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`

let storage: SqliteAdapter

const SETUP_TIMEOUT_MS = 120_000

beforeAll(() => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  const rand = random(11)
  const state = new Uint8Array(STATE_BYTES).map(() => Math.floor(rand() * 256))
  const insert = storage.db.transaction(() => {
    for (let i = 0; i < NOTES; i += 1) {
      const id = noteId(i)
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
        createdAt: NOW - 400 * DAY_MS,
        updatedAt: NOW - Math.floor(rand() * 30) * DAY_MS,
        deletedAt: null,
        deletedHlc: null,
      }
      void storage.putNote(note)
      for (let v = 0; v < VERSIONS; v += 1) {
        void storage.putRevision({
          id: `0192a6f0-0000-7000-${9000 + v}-${String(i).padStart(12, '0')}`,
          noteId: id,
          kind: 'body',
          at: NOW - Math.floor(rand() * 60) * DAY_MS - Math.floor(rand() * DAY_MS),
          ydoc: state,
          length: Math.floor(rand() * 3000),
          value: null,
        })
      }
    }
  })
  insert()
}, SETUP_TIMEOUT_MS)

afterAll(() => storage.close())

async function strips(ids: string[]) {
  const revisions = await storage.listNoteActivity(ids, activitySince(stripStart(NOW, UTC)))
  return buildStrips(ids, revisions, NOW, UTC)
}

function median(times: number[]) {
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!
}

describe(`activity strips over ${NOTES} notes`, () => {
  it(`are read and counted for the visible rows in under ${BUDGET_MS} ms`, async (context) => {
    const rand = random(3)
    const page = () => {
      const start = Math.floor(rand() * (NOTES - VISIBLE))
      return Array.from({ length: VISIBLE }, (_, i) => noteId(start + i))
    }
    const first = await strips(page())
    expect(Object.values(first).some((days) => days.some((d) => d.level > 0))).toBe(true)
    const times: number[] = []
    for (let i = 0; i < 9; i += 1) {
      const ids = page()
      const start = performance.now()
      await strips(ids)
      times.push(performance.now() - start)
    }
    expectWithinBudget(context, median(times), BUDGET_MS)
  })

  it(`cost the same whatever the size of the library: ${MAX_BODY_IDS} rows, the most one call takes`, async (context) => {
    const ids = Array.from({ length: MAX_BODY_IDS }, (_, i) => noteId(i * 20))
    await strips(ids)
    const times: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now()
      await strips(ids)
      times.push(performance.now() - start)
    }
    expectWithinBudget(context, median(times), (BUDGET_MS * MAX_BODY_IDS) / VISIBLE)
  })
})
