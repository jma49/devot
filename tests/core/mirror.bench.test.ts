import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  createMirrorRunner,
  formatHlc,
  type BookRecord,
  type MirrorRunner,
  type NoteRecord,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { folderHost, type FolderHost } from '../support/mirror-host'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// First mirror of 10,000 notes must not hold the event loop (the worker keeps answering the
// UI), and a single note edit must write exactly one file.
const NOTES = 10_000
const BOOKS = 50
/** The longest the runner may compute at a stretch; the worker answers the UI in between. */
const STALL_BUDGET_MS = 200
const EDIT_BUDGET_MS = 1500
// Setting up 10k notes and running a first mirror is not the measured stall.
const TIMEOUT_MS = 300_000

let sqlite: SqliteAdapter
let host: FolderHost
let runner: MirrorRunner
let root: string

const id = (n: number) => `0192a6f0-0000-7000-8000-${String(n).padStart(12, '0')}`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])

beforeAll(() => {
  sqlite = openSqliteAdapter(join(tempDir('devot-mirror-bench-'), 'devot.sqlite'))
  root = tempDir('devot-mirror-bench-out-')
  host = folderHost(sqlite, root)
  const insert = sqlite.db.transaction(() => {
    for (let b = 0; b < BOOKS; b += 1) {
      const hlc = formatHlc({ wall: b + 1, counter: 0, node: 'bench' })
      const book: BookRecord = {
        id: id(900_000 + b),
        name: `Notebook ${b}`,
        nameHlc: hlc,
        parentId: b >= 10 ? id(900_000 + (b % 10)) : null,
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
      void sqlite.putBook(book)
    }
    for (let i = 0; i < NOTES; i += 1) {
      const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'bench' })
      const paragraphs = Array.from(
        { length: 6 },
        (_, p) =>
          `Paragraph ${p} of note ${i}: some **bold** words and a [link](https://example.com/${p}).`,
      )
      const heading = i % 3 === 0 ? `# Heading ${i}\n\n` : ''
      const body = `${heading}${paragraphs.join('\n\n')}\n`
      const note: NoteRecord = {
        id: id(i),
        title: `Note ${i % 2000}`,
        titleHlc: hlc,
        bodyMd: body,
        ydoc: new Uint8Array([0]),
        bodyVersion: 0,
        bookId: i % 7 === 0 ? null : id(900_000 + (i % BOOKS)),
        bookHlc: hlc,
        status: i % 5 === 0 ? 'active' : 'none',
        statusHlc: hlc,
        pinned: false,
        pinnedHlc: '',
        createdAt: i,
        updatedAt: i,
        deletedAt: null,
        deletedHlc: null,
      }
      void sqlite.putNote(note)
    }
  })
  insert()
  for (let i = 0; i < 100; i += 1) {
    const fileId = id(800_000 + i)
    void sqlite.putFile({ id: fileId, noteId: id(i * 97), name: `image ${i}.png` }, PNG)
    sqlite.db
      .prepare('UPDATE notes SET body_md = body_md || ? WHERE id = ?')
      .run(`\n![image](devot://file/${fileId})\n`, id(i * 97))
  }
}, TIMEOUT_MS)

afterAll(() => {
  runner?.stop()
  sqlite.close()
})

const files = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? files(join(dir, e.name)) : e.name.startsWith('.') ? 0 : 1),
    0,
  )

/**
 * The runner as the worker runs it, timed. Storage and folder calls are IPC there, so only the
 * runner's own stretches between them count; the stand-ins here run in this thread and are left out.
 */
function timedRunner(slice?: number) {
  let resumed = performance.now()
  let longest = 0
  const suspend = () => {
    longest = Math.max(longest, performance.now() - resumed)
  }
  const resume = () => {
    resumed = performance.now()
  }
  const call =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      suspend()
      try {
        return await run(...args)
      } finally {
        resume()
      }
    }
  const timedHost = {
    open: call(host.open.bind(host)),
    bodies: call(host.bodies.bind(host)),
    files: call(host.files.bind(host)),
    hashes: call(host.hashes.bind(host)),
    check: call(host.check.bind(host)),
    apply: call(host.apply.bind(host)),
  }
  const storage = {
    listNotes: call(() => sqlite.listNotes()),
    listBooks: call(() => sqlite.listBooks()),
    listTags: call(() => sqlite.listTags()),
  }
  const made = createMirrorRunner({
    storage,
    host: timedHost,
    untitled: 'Untitled',
    delayMs: 10,
    ...(slice ? { slice } : {}),
    yieldNow: call(() => new Promise<void>((r) => setTimeout(r, 0))),
  })
  return {
    runner: made,
    longest: () => longest,
    reset: () => {
      longest = 0
      resumed = performance.now()
    },
  }
}

it(
  'mirrors 10,000 notes in the background, then writes one file for one edit',
  async (context) => {
    const timed = timedRunner()
    runner = timed.runner
    const started = performance.now()
    timed.reset()
    runner.reconcile()
    await runner.idle()
    const firstMs = performance.now() - started
    const stall = timed.longest()
    expect(files(root)).toBe(NOTES + 100)
    console.info(
      `mirror bench: first mirror ${(firstMs / 1000).toFixed(1)} s, longest stretch ${stall.toFixed(0)} ms`,
    )

    host.clear()
    const before = sqlite.db.prepare('SELECT body_md FROM notes WHERE id = ?').get(id(42)) as {
      body_md: string
    }
    sqlite.db
      .prepare('UPDATE notes SET body_md = ?, updated_at = updated_at + 1 WHERE id = ?')
      .run(`${before.body_md}One more line.\n`, id(42))
    const editStarted = performance.now()
    runner.touch()
    await runner.idle()
    const editMs = performance.now() - editStarted
    expect(host.log).toEqual({
      written: [host.manifest().notes[id(42)]!.path],
      moved: [],
      removed: [],
      kept: [],
    })
    console.info(`mirror bench: one edit ${editMs.toFixed(0)} ms`)
    expectWithinBudget(context, stall, STALL_BUDGET_MS)
    expectWithinBudget(context, editMs, EDIT_BUDGET_MS)
  },
  TIMEOUT_MS,
)
