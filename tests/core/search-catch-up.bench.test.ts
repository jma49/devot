// A save of a big note must not re-index it for search: it only marks the note stale (schema v29).
// Before, a save of a 1 MB note tokenized its old and new text, about 105 ms on a developer's Mac.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { NoteRecord } from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTE_BYTES = 1_000_000
const SAVES = 6
const BUDGET_MS = 30

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

async function save(title: string, bodyMd: string) {
  const started = performance.now()
  await storage.putNote(record(title, bodyMd))
  version += 1
  return performance.now() - started
}

beforeAll(async () => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  await save('Big', body(0))
  await storage.searchNotes(
    { text: [{ field: 'any', value: 'relay', negate: false }], sets: [], pinned: null },
    1,
  )
})

afterAll(() => storage.close())

it('saves a 1 MB note without re-indexing it', async (context) => {
  const bodies = [...Array(SAVES).keys()].map((i) => body(i + 1))
  const times: number[] = []
  for (const [i, text] of bodies.entries()) times.push(await save(i % 2 ? `Big ${i}` : 'Big', text))
  times.sort((a, b) => a - b)
  expectWithinBudget(context, times[Math.floor(SAVES / 2)]!, BUDGET_MS)
  const found = await storage.searchNotes(
    { text: [{ field: 'any', value: `Edit ${SAVES}`, negate: false }], sets: [], pinned: null },
    1,
  )
  expect(found.map((n) => n.id)).toEqual(['big'])
})
