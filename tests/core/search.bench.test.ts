import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countMatches,
  findBacklinks,
  formatHlc,
  MAX_BACKLINKS,
  noteLink,
  parseSearch,
  resolveSearch,
  savedSearchQuery,
  type BookRecord,
  type NoteRecord,
  type TagRecord,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Acceptance benchmark: listing and searching 10,000 notes takes under 50 ms (median), excerpts included.
// Notes are realistic (1 to a few KB of Markdown, Yjs state 3x the text), so most of a row sits in
// overflow pages, which neither lists nor search may read.
const NOTES = 10_000
const BUDGET_MS = 50
// Text under three characters cannot use the trigram index and reads bodies. Only a full scan (reads
// every body, nothing stops it early) gets more room; every other search keeps the product's budget.
const FULL_SCAN_BUDGET_MS = 100
// No product budget for a save; measured about 3.5 ms on a Linux runner, with room for a busy machine.
const EDIT_BUDGET_MS = 10
// The sidebar counts every saved search from the listed notes after each save, on the UI thread: one 60 Hz frame (measured about 6 ms).
const COUNTS_BUDGET_MS = 16
// Backlinks read the link index and walk the list's index to a page: measured about 1.5 ms (a page) and 1.3 ms (none) on
// a Linux runner, where the phrase search for the note's address they replaced took 84 ms, since every note here holds a
// note link and so each of the address's trigrams.
const BACKLINKS_BUDGET_MS = 10
const BOOKS = 50
const TAGS = 20
const SAVED_SEARCHES = 20
/** Every tenth note links to it, so its backlinks fill a page and more. */
const LINKED = 1

// Small vocabulary of English words and common Chinese characters, as escapes (no CJK in tracked files).
const WORDS =
  'sync relay offline merge editor preview notebook status trash search index snapshot'.split(' ')
const HAN =
  '\u540c\u6b65\u65b9\u6848\u7b14\u8bb0\u672c\u7f16\u8f91\u5668\u9884\u89c8\u641c\u7d22\u7d22\u5f15\u5feb\u7167'

function random(seed: number) {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}

let storage: SqliteAdapter

const noteId = (i: number) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`
const bookId = (b: number) => `0192a6f0-0000-7000-9000-${String(b).padStart(12, '0')}`
const tagId = (t: number) => `0192a6f0-0000-7000-a000-${String(t).padStart(12, '0')}`

// Building 10k notes is setup, not the measured work; give it room on a busy machine.
const SETUP_TIMEOUT_MS = 180_000
// A median takes 15 runs; a slow run should fail on its budget, not time out.
const TEST_TIMEOUT_MS = 60_000

beforeAll(() => {
  storage = openSqliteAdapter(join(tempDir('devot-bench-'), 'devot.sqlite'))
  const rand = random(42)
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!
  const word = () =>
    rand() < 0.5 ? pick(WORDS) : Array.from({ length: 4 }, () => pick([...HAN])).join('')
  // Yjs states: random bytes, three times as long as the text they hold.
  const noise = new Uint8Array(32_000).map(() => Math.floor(rand() * 256))
  const insert = storage.db.transaction(() => {
    for (let b = 0; b < BOOKS; b += 1) {
      const hlc = formatHlc({ wall: b + 1, counter: 0, node: 'bench' })
      const book: BookRecord = {
        id: bookId(b),
        name: `Notebook ${b}`,
        nameHlc: hlc,
        parentId: b >= 10 ? bookId(b % 10) : null,
        parentHlc: hlc,
        createdAt: b,
        updatedAt: b,
        deletedAt: null,
        deletedHlc: null,
        aiAccess: false,
        aiAccessHlc: '',
        icon: null,
        iconColor: null,
        iconHlc: '',
        sortKey: `a${String(b).padStart(3, '0')}`,
        sortKeyHlc: hlc,
      }
      void storage.putBook(book)
    }
    for (let t = 0; t < TAGS; t += 1) {
      const hlc = formatHlc({ wall: t + 1, counter: 0, node: 'bench' })
      const tag: TagRecord = {
        id: tagId(t),
        name: `t${t}`,
        nameHlc: hlc,
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
      if (i % 10 === 3) paragraphs.push(`See ${noteLink('the plan', noteId(LINKED))}.`)
      paragraphs.push(`Next: ${noteLink('next', noteId((i * 7919) % NOTES))}`)
      const bodyMd = paragraphs.join('\n\n')
      const bytes = Math.min(noise.length, bodyMd.length * 3)
      const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'bench' })
      const id = noteId(i)
      const trashed = i % 20 === 0
      const note: NoteRecord = {
        id,
        title: `Note ${i} ${pick(WORDS)}`,
        titleHlc: hlc,
        bodyMd,
        ydoc: noise.subarray(0, bytes),
        bodyVersion: 0,
        bookId: i % 9 === 0 ? null : bookId(i % BOOKS),
        bookHlc: hlc,
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
      for (const t of [i % TAGS, (i * 3 + 1) % TAGS].slice(0, 1 + (i % 2))) {
        void storage.putNoteTag({ noteId: id, tagId: tagId(t), present: true, hlc })
      }
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

async function resolved(query: string) {
  const found = resolveSearch(parseSearch(query), {
    books: await storage.listBooks(),
    tags: await storage.listTags(),
  })
  if (!found) throw new Error('E_TEST_QUERY')
  return found
}

async function search(query: string) {
  const found = await resolved(query)
  return median(() => storage.searchNotes(found, 200))
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
    ['a missing English word', 'zyxwvut'],
    ['an exclusion of a missing word', 'snapshot -zyxwvut'],
    ['the start of a word', 'snaps'],
    ['a phrase', '"merge editor"'],
    ['a tag', 'tag:t3'],
    ['a notebook with its sub-notebooks', 'book:"Notebook 3"'],
    ['a word in a notebook with a tag', 'snapshot book:"Notebook 3" tag:t3'],
    [
      'a phrase, a word start, a Chinese word, a notebook and tags with exclusions',
      '"merge editor" snaps \u7b14\u8bb0 book:"Notebook 3" tag:t3 -tag:t4 -relay status:none',
    ],
  ])(
    `answers %s in under ${BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async ([, query], context) => {
      expectWithinBudget(context, await search(query), BUDGET_MS)
    },
  )

  // A word found in nearly every note and a two-character word: the ranked matches are every note,
  // so the scan reads them in rank order and stops at a page of results (#48).
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

  // Each keystroke runs the query typed so far; every one of them keeps the budget.
  it(
    `answers every query typed on the way to two words in under ${BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const typed = 'snapshot merge'
      let slowest = 0
      for (let end = 3; end <= typed.length; end += 1) {
        const query = typed.slice(0, end).trim()
        slowest = Math.max(slowest, await search(query))
      }
      expectWithinBudget(context, slowest, BUDGET_MS)
    },
  )

  it(
    `counts ${SAVED_SEARCHES} saved searches over the listed notes in under ${COUNTS_BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const names = { books: await storage.listBooks(), tags: await storage.listTags() }
      const queries = Array.from({ length: SAVED_SEARCHES }, (_, s) =>
        savedSearchQuery(
          { query: `book:"Notebook ${s % 10}" tag:t${s} -tag:t${(s + 1) % TAGS} status:none` },
          names,
        ),
      )
      const notes = await storage.listNotes()
      const ms = await median(async () => {
        for (const query of queries) countMatches(notes, query)
      })
      expectWithinBudget(context, ms, COUNTS_BUDGET_MS)
    },
  )

  it(
    `finds a page of backlinks, and none, in under ${BACKLINKS_BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      expect(await findBacklinks(storage, noteId(LINKED))).toHaveLength(MAX_BACKLINKS)
      expectWithinBudget(
        context,
        await median(() => findBacklinks(storage, noteId(LINKED))),
        BACKLINKS_BUDGET_MS,
      )
      const unlinked = noteId(NOTES + 1)
      expect(await findBacklinks(storage, unlinked)).toEqual([])
      expectWithinBudget(
        context,
        await median(() => findBacklinks(storage, unlinked)),
        BACKLINKS_BUDGET_MS,
      )
    },
  )

  // A saved edit rewrites the note's row, its trigram index entry and its links.
  it(
    `saves an edited note into the indexes in under ${EDIT_BUDGET_MS} ms`,
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const id = noteId(4242)
      let note = (await storage.getNote(id))!
      let edit = 0
      const ms = await median(async () => {
        edit += 1
        note = {
          ...note,
          bodyMd: `${note.bodyMd}\n\nEdit ${edit} ${noteLink('more', noteId(edit))}`,
        }
        await storage.putNote(note)
        note = { ...note, bodyVersion: note.bodyVersion + 1 }
      })
      expect(await findBacklinks(storage, noteId(edit))).toContainEqual(
        expect.objectContaining({ id }),
      )
      expectWithinBudget(context, ms, EDIT_BUDGET_MS)
    },
  )
})
