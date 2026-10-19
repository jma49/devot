import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { formatHlc, parseSearch, resolveSearch, type NoteRecord } from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTES = 10_000
const BUDGET_MS = 50
// Text under three characters cannot use the trigram index: a search for it
// reads bodies (not the Yjs states). Only a full scan, which reads every
// body because nothing stops it early, gets more room; every other search
// keeps the product's budget.
const FULL_SCAN_BUDGET_MS = 100

const WORDS =
  'sync relay offline merge editor preview notebook status trash search index snapshot'.split(' ')
const HAN =
  '\u540c\u6b65\u65b9\u6848\u7b14\u8bb0\u672c\u7f16\u8f91\u5668\u9884\u89c8\u641c\u7d22\u7d22\u5f15\u5feb\u7167'

function random(seed: number) {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}

let storage: SqliteAdapter

// Building 10k notes is setup, not the measured work; give it room on a busy
// machine. The budgets below are unchanged.
const SETUP_TIMEOUT_MS = 180_000
// A median takes 15 runs; a slow run should fail on its budget, not time out.
const TEST_TIMEOUT_MS = 60_000

beforeAll(() => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  const rand = random(42)
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!
  const word = () =>
    rand() < 0.5 ? pick(WORDS) : Array.from({ length: 4 }, () => pick([...HAN])).join('')
  const noise = new Uint8Array(32_000).map(() => Math.floor(rand() * 256))
  const insert = storage.db.transaction(() => {
    for (let i = 0; i < NOTES; i += 1) {
      const paragraphs = Array.from({ length: 3 + Math.floor(rand() * 6) }, (_, p) => {
        const words = Array.from({ length: 30 + Math.floor(rand() * 30) }, (_word, k) =>
          k % 9 === 4
            ? `**${word()}**`
            : k % 13 === 6
              ? `[${word()}](https://devot.app/${k})`
              : word(),
        )
        if (p % 4 === 0) return `## ${words.slice(0, 5).join(' ')}`
        if (p % 4 === 1) return `- ${words.slice(0, 20).join(' ')}\n- ${words.slice(20).join(' ')}`
        return words.join(' ')
      })
      const bodyMd = paragraphs.join('\n\n')
      const bytes = Math.min(noise.length, bodyMd.length * 3)
      const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'bench' })
      const id = `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
      const trashed = i % 20 === 0
      const note: NoteRecord = {
        id,
        title: `Note ${i} ${pick(WORDS)}`,
        titleHlc: hlc,
        bodyMd,
        ydoc: noise.subarray(0, bytes),
        bodyVersion: 0,
        bookId: null,
        bookHlc: '',
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        createdAt: i,
        updatedAt: i,
        deletedAt: trashed ? i + 1 : null,
        deletedHlc: trashed ? hlc : null,
      }
      void storage.putNote(note)
    }
  })
  insert()
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

async function search(query: string) {
  const resolved = resolveSearch(parseSearch(query), {
    books: await storage.listBooks(),
    tags: await storage.listTags(),
  })
  if (!resolved) throw new Error('E_TEST_QUERY')
  return median(() => storage.searchNotes(resolved, 200))
}

describe(`lists and search across ${NOTES} notes of a few KB`, () => {
  it(
    `lists the notes and the Trash in under ${BUDGET_MS} ms`,
    async (context) => {
      expectWithinBudget(context, await median(() => storage.listNotes()), BUDGET_MS)
      expectWithinBudget(context, await median(() => storage.listTrash()), BUDGET_MS)
    },
    TEST_TIMEOUT_MS,
  )

  it.for<[label: string, query: string]>([
    ['an English word', 'hibernation'],
    ['a common English word', 'snapshot'],
    ['a three-character Chinese term', '\u7b14\u8bb0\u672c'],
    ['two words', 'merge preview'],
    ['a two-character Chinese word', '\u540c\u6b65'],
    ['qualifiers with an exclusion', 'title:note body:merge -relay status:none -tag:x'],
    ['qualifiers alone', 'status:active'],
    // Worst cases: nothing matches, so every note is examined.
    ['a missing English word', 'zyxwvut'],
    ['an exclusion of a missing word', 'snapshot -zyxwvut'],
  ])(
    `answers %s in under ${BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async ([, query], context) => {
      expectWithinBudget(context, await search(query), BUDGET_MS)
    },
  )

  // A word found in nearly every note and a two-character word: the
  // ranked matches are every note, so the scan reads them in rank order and
  // stops at a page of results (#48).
  it(
    `answers a word and a two-character Chinese word in under ${BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      expectWithinBudget(context, await search('merge \u9884\u89c8'), BUDGET_MS)
    },
  )

  it(
    `scans every body for a missing two-character word in under ${FULL_SCAN_BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      expectWithinBudget(context, await search('qz'), FULL_SCAN_BUDGET_MS)
    },
  )
})
