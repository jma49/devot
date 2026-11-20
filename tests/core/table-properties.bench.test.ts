import { join } from 'node:path'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  formatHlc,
  type NoteRecord,
  type NoteSummary,
} from '../../src/core'
import { readProperties, type Properties } from '../../src/core/properties'
import { tableColumns, tableRows, withFilter, NO_SETTINGS } from '../../src/renderer/src/table'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTES = 10_000
// The table asks in batches of this many, as NoteTable does.
const BATCH = 500
const READ_BUDGET_MS = 800
const ROWS_BUDGET_MS = 60
const BODY = 'word '.repeat(1_600)

let storage: SqliteAdapter
let ids: string[]

beforeAll(() => {
  storage = openSqliteAdapter(join(tempDir('devot-table-bench-'), 'devot.sqlite'))
  const state = Y.encodeStateAsUpdate(new Y.Doc())
  ids = []
  storage.db.transaction(() => {
    for (let i = 0; i < NOTES; i += 1) {
      const id = `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
      ids.push(id)
      const head =
        i % 2 === 0
          ? `---\nrating: ${i % 10}\ndone: ${i % 3 === 0}\ndue: 2026-12-${String((i % 28) + 1).padStart(2, '0')}\nowner: Person ${i % 50}\nlabels: [a, b]\n---\n`
          : ''
      const note: NoteRecord = {
        id,
        title: `Note ${i}`,
        titleHlc: formatHlc({ wall: i + 1, counter: 0, node: 'bench' }),
        bodyMd: head + BODY,
        ydoc: state,
        bodyVersion: 0,
        bookId: null,
        bookHlc: '',
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        createdAt: i,
        updatedAt: i,
        deletedAt: null,
        deletedHlc: null,
      }
      void storage.putNote(note)
    }
  })()
}, 120_000)

afterAll(() => storage.close())

async function readAll(): Promise<Map<string, Properties>> {
  const notes = createNoteService({
    storage,
    clock: createClock('bench'),
    newId: createIdGenerator(),
  })
  const found = new Map<string, Properties>()
  for (let at = 0; at < ids.length; at += BATCH) {
    const heads = await notes.frontMatterHeads(ids.slice(at, at + BATCH))
    for (const id in heads) found.set(id, readProperties(heads[id]!))
  }
  return found
}

const median = (times: number[]) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!

describe(`the table over ${NOTES} notes of 8 KB`, () => {
  it(`reads every note's properties in under ${READ_BUDGET_MS} ms`, async (context) => {
    expect((await readAll()).size).toBe(NOTES / 2)
    const times: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now()
      await readAll()
      times.push(performance.now() - start)
    }
    expectWithinBudget(context, median(times), READ_BUDGET_MS)
  })

  it(`types, filters and sorts its rows in under ${ROWS_BUDGET_MS} ms`, async (context) => {
    const properties = await readAll()
    const notes: NoteSummary[] = ids.map((id, i) => ({
      id,
      title: `Note ${i}`,
      createdAt: i,
      updatedAt: i,
      bookId: null,
      status: 'none',
      pinned: false,
      tagIds: [],
      bodyVersion: 0,
    }))
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    const settings = {
      ...withFilter(NO_SETTINGS, 'property:rating', 'filled'),
      sort: { column: 'property:owner', descending: true },
    }
    const times: number[] = []
    let shown = 0
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now()
      const columns = tableColumns(notes, properties, settings, collator)
      shown = tableRows(notes, columns, properties, settings, () => [], collator).length
      times.push(performance.now() - start)
    }
    expect(shown).toBe(NOTES / 2)
    expectWithinBudget(context, median(times), ROWS_BUDGET_MS)
  })
})
