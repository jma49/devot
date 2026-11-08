// A save of a big note must not re-index it for search: it only marks the note stale (schema v29).
// Before, a save of a 1 MB note tokenized its old and new text, about 105 ms on a developer's Mac.
// Both are timed in CPU: the store syncs every commit to disk, and a hosted runner's disk, shared
// with the other benchmarks' stores, put the wall-clock median of six saves at up to 420 ms against
// its 30 ms budget.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { NoteRecord } from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { cpuMs } from '../support/growth'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTE_BYTES = 1_000_000
const SAVES = 6
const BUDGET_MS = 30
const SEARCH_BUDGET_MS = 150

let storage: SqliteAdapter
let version = 0

function body(edit: number) {
  const words = ['relay', 'launch', 'orbit', 'garden', 'kiwi', 'snapshot', 'planet']
  let text = `Edit ${edit} `
  for (let i = 0; text.length < NOTE_BYTES; i += 1)
    text += `${words[(i * 7 + edit) % words.length]}${i % 97} `
  return text
}

function record(title: string, bodyMd: string): NoteRecord {
  return {
    id: 'big',
    title,
    titleHlc: `${String(version + 1).padStart(13, '0')}-0000-bench`,
    bodyMd,
    ydoc: new Uint8Array([1]),
    bodyVersion: version,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 1,
    updatedAt: 1 + version,
    deletedAt: null,
    deletedHlc: null,
  }
}

const query = (value: string) => ({
  text: [{ field: 'any' as const, value, negate: false }],
  sets: [],
  pinned: null,
})

async function save(title: string, bodyMd: string) {
  const note = record(title, bodyMd)
  const ms = await cpuMs(() => storage.putNote(note))
  version += 1
  return ms
}

beforeAll(async () => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  await save('Big', body(0))
  await storage.searchNotes(query('relay'), 1)
})

afterAll(() => storage.close())

const staleNotes = () =>
  (storage.db.prepare('SELECT count(*) AS n FROM search_stale').get() as { n: number }).n

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!

// The save is also held to half the re-index it skipped, measured just after it on the same
// machine: on any machine, a save that tokenized its text would cost more.
it('saves a 1 MB note without re-indexing it', { timeout: 60_000 }, async (context) => {
  const saves: number[] = []
  const reindexes: number[] = []
  for (let i = 0; i < SAVES; i += 1) {
    saves.push(await save(i % 2 ? `Big ${i}` : 'Big', body(i + 1)))
    expect(staleNotes()).toBe(1)
    reindexes.push(await cpuMs(async () => storage.catchUpSearchIndex()))
  }
  expectWithinBudget(context, median(saves), BUDGET_MS)
  expectWithinBudget(context, median(saves), median(reindexes) / 2, { exact: true })
  const found = await storage.searchNotes(query(`Edit ${SAVES}`), 1)
  expect(found.map((n) => n.id)).toEqual(['big'])
})

// The first search after such a save pays for the re-index the save skipped.
it(
  're-indexes a 1 MB note in the first search after its save',
  { timeout: 60_000 },
  async (context) => {
    const times: number[] = []
    for (let i = 0; i < SAVES; i += 1) {
      const edit = SAVES + 1 + i
      await save('Big', body(edit))
      let found: { id: string }[] = []
      times.push(
        await cpuMs(async () => (found = await storage.searchNotes(query(`Edit ${edit}`), 1))),
      )
      expect(found.map((n) => n.id)).toEqual(['big'])
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[Math.floor(SAVES / 2)]!, SEARCH_BUDGET_MS)
  },
)
