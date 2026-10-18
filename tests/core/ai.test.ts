// What AI tools (devot-mcp) can see and do, on real SQLite: only the live
// notes filed directly in notebooks with Allow AI Access on.
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  KEEP_NEWEST,
  parseHlc,
  snippet,
  MAX_AI_BODY_BYTES,
  MAX_NOTE_LINKS,
  noteLink,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const path = join(tempDir('devot-ai-'), 'devot.sqlite')
  const storage = openSqliteAdapter(path)
  open.push(storage)
  // The app's side: its own clock and services.
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const books = createBookService({ storage, clock, newId })
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage, clock, newId })
  // devot-mcp's side: the same file, its own clock.
  const ai = createAiService({
    storage,
    clock: createClock('mcptest'),
    newId: createIdGenerator(),
    atomically: storage.atomically,
  })
  return { storage, books, notes, tags, ai, path }
}

type Setup = ReturnType<typeof setup>

async function note({ notes }: Setup, title: string, body: string, bookId: string | null) {
  const id = await notes.create(title, bookId)
  await notes.setBody(id, body)
  await notes.flush()
  return id
}

/**
 * Notebooks: Shared (allowed) with a sub-notebook Inside (not allowed),
 * Private (not allowed), and Gone (allowed, then deleted). Every note holds
 * the word "kiwi".
 */
async function world(s: Setup) {
  const shared = await s.books.create('Shared', null)
  const inside = await s.books.create('Inside', shared)
  const priv = await s.books.create('Private', null)
  const gone = await s.books.create('Gone', null)
  await s.books.setAiAccess(shared, true)
  await s.books.setAiAccess(gone, true)
  const ids = {
    shared: await note(s, 'Shared kiwi', 'A shared kiwi note.', shared),
    inside: await note(s, 'Inside kiwi', 'A kiwi in a sub-notebook.', inside),
    priv: await note(s, 'Private kiwi', 'A private kiwi note.', priv),
    loose: await note(s, 'Loose kiwi', 'A kiwi in no notebook.', null),
    trashed: await note(s, 'Trashed kiwi', 'A kiwi in the trash.', shared),
    purged: await note(s, 'Purged kiwi', 'A purged kiwi.', shared),
    orphan: await note(s, 'Orphan kiwi', 'A kiwi whose notebook was deleted.', gone),
  }
  await s.notes.trash(ids.trashed)
  await s.notes.trash(ids.purged)
  await s.notes.purge(ids.purged)
  await s.books.remove(gone)
  return { books: { shared, inside, priv, gone }, ids }
}

describe('what AI can see', () => {
  it('lists only live notebooks with the switch on, without inheriting it', async () => {
    const s = setup()
    const { books } = await world(s)
    expect(await s.ai.notebooks()).toEqual([{ id: books.shared, name: 'Shared', notes: 1 }])
  })

  it('searches only the live notes filed directly in allowed notebooks', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    const hits = await s.ai.search('kiwi')
    expect(hits.map((h) => h.id)).toEqual([ids.shared])
    expect(hits[0]).toMatchObject({
      title: 'Shared kiwi',
      notebook: { id: books.shared, name: 'Shared' },
    })
    expect(hits[0]?.snippet).toContain('shared kiwi note')
    // Words that only hidden notes contain find nothing.
    for (const query of ['private', 'sub-notebook', 'trash', 'purged', 'deleted', 'no notebook']) {
      expect(await s.ai.search(query)).toEqual([])
    }
  })

  it('understands the app query qualifiers without revealing hidden notebooks', async () => {
    const s = setup()
    const { ids } = await world(s)
    await s.tags.addToNote(ids.shared, 'fruit')
    await s.tags.addToNote(ids.priv, 'fruit')
    await s.notes.flush()
    expect((await s.ai.search('kiwi book:shared')).map((h) => h.id)).toEqual([ids.shared])
    expect((await s.ai.search('tag:FRUIT')).map((h) => h.id)).toEqual([ids.shared])
    expect(await s.ai.search('kiwi -tag:fruit')).toEqual([])
    // A hidden notebook cannot be named, or found by excluding the rest.
    expect(await s.ai.search('kiwi book:Private')).toEqual([])
    expect(await s.ai.search('kiwi book:Inside')).toEqual([])
    expect((await s.ai.search('kiwi -book:Private')).map((h) => h.id)).toEqual([ids.shared])
    expect(await s.ai.search('kiwi -book:Shared')).toEqual([])
    // The snippet follows the words searched for in the body.
    const [hit] = await s.ai.search('title:shared body:note')
    expect(hit?.snippet).toContain('note')
  })

  it('searches by ID and pinned state without revealing hidden notebooks', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    const tagId = await s.tags.addToNote(ids.shared, 'fruit')
    await s.notes.setPinned(ids.shared, true)
    await s.notes.flush()
    const found = async (query: string) => (await s.ai.search(query)).map((h) => h.id)
    expect(await found(`kiwi bookId:${books.shared}`)).toEqual([ids.shared])
    expect(await found(`kiwi tagId:${tagId}`)).toEqual([ids.shared])
    expect(await found('kiwi pinned:true')).toEqual([ids.shared])
    expect(await found('kiwi pinned:false')).toEqual([])
    // A notebook AI may not see cannot be named by its ID either.
    expect(await found(`kiwi bookId:${books.priv}`)).toEqual([])
    expect(await found(`kiwi bookId:${books.inside}`)).toEqual([])
    expect(await found(`kiwi -bookId:${books.priv}`)).toEqual([ids.shared])
    expect(await found(`kiwi -bookId:${books.shared}`)).toEqual([])
  })

  it('reads an allowed note with its metadata', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    const tagId = await s.tags.addToNote(ids.shared, 'fruit')
    expect(tagId).toBeTruthy()
    await s.notes.setStatus(ids.shared, 'active')
    await s.notes.flush()
    const read = await s.ai.read(ids.shared)
    expect(read).toMatchObject({
      id: ids.shared,
      title: 'Shared kiwi',
      markdown: 'A shared kiwi note.',
      notebook: { id: books.shared, name: 'Shared' },
      status: 'active',
      pinned: false,
      tags: ['fruit'],
    })
    expect(read.createdAt).toBeGreaterThan(0)
    expect(read.updatedAt).toBeGreaterThanOrEqual(read.createdAt)
  })

  it('answers every hidden or unknown note the same way, revealing nothing', async () => {
    const s = setup()
    const { ids } = await world(s)
    const hidden = [ids.inside, ids.priv, ids.loose, ids.trashed, ids.purged, ids.orphan]
    const unknown = ['0192a6f0-0000-7000-8000-000000000999', 'not-an-id', '', '../x']
    for (const id of [...hidden, ...unknown]) {
      await expect(s.ai.read(id)).rejects.toThrow(/^E_NOTE_NOT_FOUND$/)
    }
  })

  it('hides a notebook as soon as its switch goes off', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    await s.books.setAiAccess(books.shared, false)
    expect(await s.ai.notebooks()).toEqual([])
    expect(await s.ai.search('kiwi')).toEqual([])
    await expect(s.ai.read(ids.shared)).rejects.toThrow('E_NOTE_NOT_FOUND')
  })

  it('finds allowed notes even when many hidden notes match better', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    const priv = await s.books.create('Private', null)
    await s.books.setAiAccess(shared, true)
    for (let i = 0; i < 60; i += 1) await note(s, `mango ${i}`, 'mango mango mango', priv)
    const id = await note(s, 'One', 'a mango', shared)
    expect((await s.ai.search('mango', 5)).map((h) => h.id)).toEqual([id])
  })

  it('limits results and refuses an empty query', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    for (let i = 0; i < 4; i += 1) await note(s, `plum ${i}`, 'plum', shared)
    expect(await s.ai.search('plum', 2)).toHaveLength(2)
    expect(await s.ai.search('plum')).toHaveLength(4)
    await expect(s.ai.search('   ')).rejects.toThrow('E_SEARCH_QUERY_EMPTY')
  })

  it('searches short terms and Chinese text too', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    // "\u540c\u6b65" is a two-character Chinese word ("sync").
    const id = await note(s, 'Plan', 'Notes on \u540c\u6b65 and more.', shared)
    const [hit] = await s.ai.search('\u540c\u6b65')
    expect(hit?.id).toBe(id)
    expect(hit?.snippet).toContain('\u540c\u6b65')
  })
})

describe('creating notes', () => {
  it('creates a note in an allowed notebook named by ID, with the body as Yjs operations', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    const markdown = '# Plan\r\n\r\n- one\r\n- two\n'
    const created = await s.ai.create({ title: 'From AI', markdown, notebook: shared })
    expect(created).toMatchObject({ title: 'From AI', notebook: { id: shared, name: 'Shared' } })

    const record = (await s.storage.getNote(created.id))!
    expect(record.bookId).toBe(shared)
    expect(record.title).toBe('From AI')
    // Line breaks become \n, and the snapshot is what the Yjs document holds.
    expect(record.bodyMd).toBe('# Plan\n\n- one\n- two\n')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, record.ydoc)
    expect(doc.getText(BODY).toString()).toBe(record.bodyMd)
    // Its clocks carry devot-mcp's own node ID.
    expect(parseHlc(record.titleHlc).node).toBe('mcptest')
    expect(parseHlc(record.bookHlc).node).toBe('mcptest')

    // The app sees it, opens it and can edit it.
    expect((await s.notes.list()).map((n) => n.id)).toContain(created.id)
    const opened = await s.notes.open(created.id)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, opened.state)
    expect(replica.getText(BODY).toString()).toBe(record.bodyMd)
    // AI reads it back.
    expect((await s.ai.read(created.id)).markdown).toBe(record.bodyMd)
    expect((await s.ai.search('Plan')).map((h) => h.id)).toEqual([created.id])
  })

  it('takes an allowed notebook by its exact name', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    const created = await s.ai.create({ title: 'By name', markdown: 'x', notebook: 'Shared' })
    expect(created.notebook.id).toBe(shared)
    await expect(
      s.ai.create({ title: 'Wrong case', markdown: 'x', notebook: 'shared' }),
    ).rejects.toThrow('E_BOOK_NOT_FOUND')
  })

  it('refuses notebooks without AI access, deleted or unknown, the same way', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    const inside = await s.books.create('Inside', shared)
    const priv = await s.books.create('Private', null)
    const gone = await s.books.create('Gone', null)
    await s.books.setAiAccess(shared, true)
    await s.books.setAiAccess(gone, true)
    await s.books.remove(gone)
    for (const notebook of [inside, 'Inside', priv, 'Private', gone, 'Gone', 'Nowhere', '']) {
      await expect(s.ai.create({ title: 'No', markdown: 'x', notebook })).rejects.toThrow(
        /^E_BOOK_NOT_FOUND$/,
      )
    }
    expect(await s.notes.list()).toEqual([])
  })

  it('refuses a name two allowed notebooks share', async () => {
    const s = setup()
    const a = await s.books.create('Inbox', null)
    const b = await s.books.create('Inbox', null)
    await s.books.setAiAccess(a, true)
    await s.books.setAiAccess(b, true)
    await expect(s.ai.create({ title: 'T', markdown: '', notebook: 'Inbox' })).rejects.toThrow(
      'E_BOOK_AMBIGUOUS',
    )
    // By ID it works.
    expect((await s.ai.create({ title: 'T', markdown: '', notebook: b })).notebook.id).toBe(b)
  })

  it('refuses bad titles and oversized bodies, leaving nothing behind', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    const bad = [
      { title: '', markdown: 'x' },
      { title: '   ', markdown: 'x' },
      { title: 'two\nlines', markdown: 'x' },
      { title: 'two\rlines', markdown: 'x' },
      { title: 'x'.repeat(1001), markdown: 'x' },
    ]
    for (const input of bad) {
      await expect(s.ai.create({ ...input, notebook: shared })).rejects.toThrow(
        'E_NOTE_TITLE_INVALID',
      )
    }
    await expect(
      s.ai.create({ title: 'Big', markdown: 'x'.repeat(MAX_AI_BODY_BYTES + 1), notebook: shared }),
    ).rejects.toThrow('E_NOTE_BODY_TOO_LARGE')
    expect(await s.notes.list()).toEqual([])
  })

  it('refuses more note links than the app can save, as the app does', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    const newId = createIdGenerator()
    const ids = Array.from({ length: MAX_NOTE_LINKS + 1 }, () => newId())
    const index = ids.map((id) => noteLink('n', id)).join('\n')
    // Well under the size limit: only the link count is wrong.
    expect(new TextEncoder().encode(index).length).toBeLessThan(MAX_AI_BODY_BYTES)
    await expect(
      s.ai.create({ title: 'Index', markdown: index, notebook: shared }),
    ).rejects.toThrow('E_NOTE_LINKS_TOO_MANY')
    expect(await s.notes.list()).toEqual([])
    // Exactly the limit is fine.
    const atLimit = ids
      .slice(1)
      .map((id) => noteLink('n', id))
      .join('\n')
    await s.ai.create({ title: 'Index', markdown: atLimit, notebook: shared })
    expect(await s.notes.list()).toHaveLength(1)
  })

  it('writes the note and its body in one transaction', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    // Count the commits other connections see.
    const watcher = openSqliteAdapter(s.path)
    open.push(watcher)
    const version = () => watcher.db.pragma('data_version', { simple: true }) as number
    const before = version()
    await s.ai.create({ title: 'Once', markdown: 'body', notebook: shared })
    expect(version()).toBe(before + 1)
  })
})

/**
 * The app writing on its own connection, in a thread of its own, while
 * devot-mcp works: it writes one small row again and again and, when
 * stopped, reports how many writes it made and the longest one took
 * (waiting for the database included).
 */
async function appWriter(path: string, bookId: string) {
  const driver = createRequire(import.meta.url).resolve('better-sqlite3')
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
    const Database = require(workerData.driver)
    const db = new Database(workerData.path)
    db.pragma('busy_timeout = 5000')
    const write = db.prepare('UPDATE books SET updated_at = updated_at WHERE id = ?')
    let stop = false
    let longest = 0
    let writes = 0
    parentPort.on('message', () => (stop = true))
    const loop = () => {
      if (stop) {
        db.close()
        parentPort.postMessage({ longest, writes })
        return
      }
      const start = performance.now()
      write.run(workerData.bookId)
      longest = Math.max(longest, performance.now() - start)
      writes += 1
      setImmediate(loop)
    }
    parentPort.postMessage('ready')
    loop()`,
    { eval: true, workerData: { driver, path, bookId } },
  )
  await once(worker, 'message')
  return {
    async stop(): Promise<{ longest: number; writes: number }> {
      const result = once(worker, 'message')
      worker.postMessage('stop')
      const [report] = (await result) as [{ longest: number; writes: number }]
      await worker.terminate()
      return report
    },
  }
}

describe('creating notes beside a long history', () => {
  it('thins no history and holds the write lock briefly, while the app writes', async (context) => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await s.books.setAiAccess(shared, true)
    // 200 notes AI may see, each with versions a sweep would thin: its
    // newest from today, and two from one hour a month ago.
    const now = Date.now()
    const month = Math.floor((now - 30 * 86_400_000) / 3_600_000) * 3_600_000
    const state = new Uint8Array(8_000).map((_, i) => (i * 31) % 251)
    let n = 0
    const versionId = () => `0192a6f0-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`
    s.storage.db.transaction(() => {
      for (let i = 0; i < 200; i += 1) {
        const id = `0192a6f0-0000-7000-9000-${String(i).padStart(12, '0')}`
        void s.storage.putNote({
          id,
          title: `Kept ${i}`,
          titleHlc: '0001728000000000-0000-app',
          bodyMd: 'kept',
          ydoc: state,
          bodyVersion: 0,
          bookId: shared,
          bookHlc: '0001728000000000-0000-app',
          status: 'none',
          statusHlc: '',
          pinned: false,
          pinnedHlc: '',
          createdAt: month,
          updatedAt: month,
          deletedAt: null,
          deletedHlc: null,
        })
        const times = [
          ...Array.from({ length: KEEP_NEWEST }, (_, k) => now - (k + 1) * 60_000),
          month + 40 * 60_000,
          month + 10 * 60_000,
        ]
        for (const at of times) {
          void s.storage.putRevision({
            id: versionId(),
            noteId: id,
            kind: 'body',
            at,
            ydoc: state,
            length: 4,
            value: null,
          })
        }
      }
    })()
    const revisions = () =>
      (s.storage.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n
    const before = revisions()

    // devot-mcp's side, on its own connection, timing how long each create
    // holds the write lock; any history read or compaction call is noted.
    const mcp = openSqliteAdapter(s.path, { migrate: false })
    open.push(mcp)
    const calls: string[] = []
    const methods = mcp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    for (const name of ['listRevisions', 'listCompactable', 'compactRevisions', 'lastCompaction']) {
      const real = methods[name]!.bind(mcp)
      methods[name] = async (...args: unknown[]) => {
        calls.push(name)
        return real(...args)
      }
    }
    let held = 0
    const ai = createAiService({
      storage: mcp,
      clock: createClock('mcptest'),
      newId: createIdGenerator(),
      atomically: (work) =>
        mcp.atomically(async () => {
          const start = performance.now()
          try {
            return await work()
          } finally {
            held = Math.max(held, performance.now() - start)
          }
        }),
    })

    const app = await appWriter(s.path, shared)
    for (let i = 0; i < 3; i += 1) {
      await ai.create({ title: `From AI ${i}`, markdown: 'A new note.', notebook: shared })
    }
    const { longest, writes } = await app.stop()

    expect(calls).toEqual([])
    expect(revisions()).toBe(before)
    expect(writes).toBeGreaterThan(0)
    const made = (await s.notes.list()).filter((summary) => summary.title.startsWith('From AI'))
    expect(made).toHaveLength(3)
    expectWithinBudget(context, held, 50)
    expectWithinBudget(context, longest, 250)
  })
})

describe('atomically', () => {
  it('rolls every write back when the work fails', async () => {
    const s = setup()
    const shared = await s.books.create('Shared', null)
    await expect(
      s.storage.atomically(async () => {
        const id = await s.notes.create('Half made', shared)
        await s.notes.release(id)
        throw new Error('E_TEST_FAILED')
      }),
    ).rejects.toThrow('E_TEST_FAILED')
    expect(await s.storage.listNotes()).toEqual([])
    // The connection is usable afterwards, and runs queue up.
    const results = await Promise.all([
      s.storage.atomically(async () => s.notes.create('A', null)),
      s.storage.atomically(async () => s.notes.create('B', null)),
    ])
    expect(results).toHaveLength(2)
    expect((await s.storage.listNotes()).map((n) => n.title).sort()).toEqual(['A', 'B'])
  })
})

describe('snippet', () => {
  it('shows the text around the first match, on one line', () => {
    const text = `${'lead '.repeat(40)}the KIWI\nis here${' tail'.repeat(40)}`
    const out = snippet(text, ['kiwi'])
    expect(out).toContain('the KIWI is here')
    expect(out.startsWith('\u2026')).toBe(true)
    expect(out.endsWith('\u2026')).toBe(true)
    expect([...out].length).toBeLessThanOrEqual(200)
  })

  it('finds the match even when lower-casing would change the text length', () => {
    // "\u0130" lower-cases to two UTF-16 units.
    const text = `${'\u0130'.repeat(120)} then Kiwi`
    expect(snippet(text, ['kiwi'])).toContain('then Kiwi')
  })

  it('takes terms literally, not as patterns', () => {
    expect(snippet(`${'x'.repeat(200)} a+b (c) [d]`, ['a+b'])).toContain('a+b (c) [d]')
  })

  it('starts at the top when no term is in the text', () => {
    expect(snippet('Short body.', ['title-only'])).toBe('Short body.')
    expect(snippet('', ['x'])).toBe('')
  })

  it('never splits a surrogate pair', () => {
    const text = `${'\u{1F600}'.repeat(100)}kiwi${'\u{1F600}'.repeat(100)}`
    const out = snippet(text, ['kiwi'])
    expect(out).toContain('kiwi')
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})
