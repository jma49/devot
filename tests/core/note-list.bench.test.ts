// What the list's first page, the link targets of a note and the `[[` popup cost in a library of
// 50,000 notes. The docs set no budget for these; each budget is a baseline measured on a Linux
// runner with room for a busy machine.
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  formatHlc,
  TEMPLATES_BOOK_ID,
  type NoteRecord,
  type NoteService,
  type TagRecord,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTES = 50_000
const TAGS = 20
/** The first page of the list, as the window asks for it. */
const PAGE = 21
/** About as many links as a long note shows. */
const LINKED = 40
const LIST_BUDGET_MS = 5
const TARGETS_BUDGET_MS = 10
const POPUP_BUDGET_MS = 20
const SETUP_TIMEOUT_MS = 300_000
const TEST_TIMEOUT_MS = 60_000

const WORDS =
  'sync relay offline merge editor preview notebook status trash search index snapshot'.split(' ')

function random(seed: number) {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}

const noteId = (i: number) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
const tagId = (t: number) => `0192a6f0-0000-7000-a000-${String(t).padStart(12, '0')}`

let storage: SqliteAdapter
let notes: NoteService

beforeAll(() => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  const rand = random(7)
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!
  const noise = new Uint8Array(6_000).map(() => Math.floor(rand() * 256))
  storage.db.transaction(() => {
    for (let t = 0; t < TAGS; t += 1) {
      const tag: TagRecord = {
        id: tagId(t),
        name: `t${t}`,
        nameHlc: formatHlc({ wall: t + 1, counter: 0, node: 'bench' }),
        createdAt: t,
        updatedAt: t,
        deletedAt: null,
        deletedHlc: null,
        color: null,
        colorHlc: '',
      }
      void storage.putTag(tag)
    }
    for (let i = 0; i < NOTES; i += 1) {
      const bodyMd = Array.from({ length: 4 }, () =>
        Array.from({ length: 40 }, () => pick(WORDS)).join(' '),
      ).join('\n\n')
      const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'bench' })
      const note: NoteRecord = {
        id: noteId(i),
        title: `Note ${i} ${pick(WORDS)}`,
        titleHlc: hlc,
        bodyMd,
        ydoc: noise.subarray(0, bodyMd.length * 3),
        bodyVersion: 0,
        // The newest notes are templates, which the list leaves out.
        bookId: i >= NOTES - 30 ? TEMPLATES_BOOK_ID : null,
        bookHlc: hlc,
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
      void storage.putNoteTag({
        noteId: note.id,
        tagId: tagId(i % TAGS),
        present: true,
        hlc,
      })
    }
  })()
  notes = createNoteService({
    storage,
    clock: createClock('bench'),
    newId: createIdGenerator(),
  })
}, SETUP_TIMEOUT_MS)

afterAll(() => storage.close())

async function median(work: () => Promise<unknown>) {
  const times: number[] = []
  for (let i = 0; i < 15; i += 1) {
    const start = performance.now()
    await work()
    times.push(performance.now() - start)
  }
  return times.sort((a, b) => a - b)[7]!
}

describe(`the list and link lookups across ${NOTES} notes`, () => {
  it(
    `lists the first ${PAGE} notes, templates left out, in under ${LIST_BUDGET_MS} ms`,
    async (context) => {
      const page = await notes.list(PAGE)
      expect(page.map((n) => n.id)).toEqual(
        Array.from({ length: PAGE }, (_, k) => noteId(NOTES - 31 - k)),
      )
      const ms = await median(() => notes.list(PAGE))
      expectWithinBudget(context, ms, LIST_BUDGET_MS)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    `finds the link targets of a note with ${LINKED} links in under ${TARGETS_BUDGET_MS} ms`,
    async (context) => {
      const ids = Array.from({ length: LINKED }, (_, k) => noteId(k * 1_000 + 17))
      const found = await notes.linkTargets(ids)
      expect(Object.keys(found).sort()).toEqual([...ids].sort())
      expect(found[noteId(17)]?.tags).toEqual([{ name: 't17', color: null }])
      const ms = await median(() => notes.linkTargets(ids))
      expectWithinBudget(context, ms, TARGETS_BUDGET_MS)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    `answers a two-character [[ query in under ${POPUP_BUDGET_MS} ms`,
    async (context) => {
      const lookup = { flush: false, shortInTitles: true } as const
      const { found } = await notes.search('e 4', undefined, lookup)
      expect(found.length).toBeGreaterThan(0)
      const ms = await median(() => notes.search('xq', undefined, lookup))
      expectWithinBudget(context, ms, POPUP_BUDGET_MS)
    },
    TEST_TIMEOUT_MS,
  )
})
