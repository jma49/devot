// What AI tools (devot-mcp) can see and do, on real SQLite: only the live
// notes filed directly in notebooks with Allow AI Access on.
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyPatches,
  BODY,
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  KEEP_NEWEST,
  MAX_AI_BODY_BYTES,
  MAX_AI_PATCHES,
  MAX_AI_TAGS,
  MAX_NOTE_LINKS,
  newWriter,
  noteLink,
  parseHlc,
  snippet,
} from '../../src/core'

import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const WRITER = newWriter('mcp', 'Claude Code', 'mcptest')

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const path = join(tempDir('devot-ai-'), 'devot.sqlite')
  const storage = openSqliteAdapter(path)
  open.push(storage)
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
    writer: () => WRITER,
  })
  return { storage, books, notes, tags, ai, path }
}

type Setup = ReturnType<typeof setup>

const HIDDEN_NOTES = ['inside', 'priv', 'loose', 'trashed', 'purged', 'orphan'] as const

async function note({ notes }: Setup, title: string, body: string, bookId: string | null) {
  const id = await notes.create(title, bookId)
  await notes.setBody(id, body)
  await notes.flush()
  return id
}

/**
 * Shared (allowed) with a sub-notebook Inside (not allowed), Private (not allowed),
 * Gone (allowed, then deleted). Every note holds the word "kiwi".
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

    expect((await s.notes.list()).map((n) => n.id)).toContain(created.id)
    const opened = await s.notes.open(created.id)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, opened.state)
    expect(replica.getText(BODY).toString()).toBe(record.bodyMd)
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
    const watcher = openSqliteAdapter(s.path)
    open.push(watcher)
    const version = () => watcher.db.pragma('data_version', { simple: true }) as number
    const before = version()
    await s.ai.create({ title: 'Once', markdown: 'body', notebook: shared })
    expect(version()).toBe(before + 1)
  })
})

/**
 * The app writing on its own connection in its own thread while devot-mcp works;
 * on stop, the writes made and the longest (database wait included).
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

async function versionTexts(s: Setup, id: string): Promise<string[]> {
  const texts: string[] = []
  for (const summary of (await s.storage.listRevisions(id)).filter((r) => r.kind === 'body')) {
    const revision = await s.storage.getRevision(summary.id)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, revision!.ydoc!)
    texts.unshift(doc.getText(BODY).toString())
  }
  return texts
}

describe('editing notes', () => {
  it('changes the body, title, notebook and status, keeping the old body as a version', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    const other = await s.books.create('Other', null)
    await s.books.setAiAccess(other, true)
    expect(await versionTexts(s, ids.shared)).not.toContain('A shared kiwi note.')

    const updated = await s.ai.update({
      id: ids.shared,
      title: '  Renamed  ',
      body: { markdown: 'A new body.\r\nTwo lines.' },
      notebook: 'Other',
      status: 'active',
    })
    expect(updated).toMatchObject({
      id: ids.shared,
      title: 'Renamed',
      markdown: 'A new body.\nTwo lines.',
      notebook: { id: other, name: 'Other' },
      status: 'active',
    })
    const record = (await s.storage.getNote(ids.shared))!
    // The snapshot is what the Yjs document holds, written by devot-mcp's clock.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, record.ydoc)
    expect(doc.getText(BODY).toString()).toBe('A new body.\nTwo lines.')
    expect(parseHlc(record.titleHlc).node).toBe('mcptest')
    expect(parseHlc(record.bookHlc).node).toBe('mcptest')
    expect(await versionTexts(s, ids.shared)).toContain('A shared kiwi note.')
    const kinds = (await s.storage.listRevisions(ids.shared)).map((r) => r.kind)
    expect(kinds).toEqual(expect.arrayContaining(['title', 'book', 'status']))
    expect(books.shared).not.toBe(other)
  })

  it('keeps the text from before each edit, one version per edit', async () => {
    const s = setup()
    const { ids } = await world(s)
    await s.ai.update({ id: ids.shared, body: { markdown: 'First edit.' } })
    await s.ai.update({ id: ids.shared, body: { markdown: 'Second edit.' } })
    const texts = await versionTexts(s, ids.shared)
    expect(texts).toEqual(expect.arrayContaining(['A shared kiwi note.', 'First edit.']))
    expect(texts).not.toContain('Second edit.')
    expect((await s.ai.read(ids.shared)).markdown).toBe('Second edit.')
  })

  it('replaces exact passages in order, and refuses one found never or twice', async () => {
    const s = setup()
    const { ids } = await world(s)
    await s.ai.update({ id: ids.shared, body: { markdown: 'one two\nthree two' } })
    const updated = await s.ai.update({
      id: ids.shared,
      body: {
        patches: [
          { find: 'one two', replace: 'ONE' },
          // Found once now that the first patch replaced the other.
          { find: 'two', replace: '2\r\n' },
        ],
      },
    })
    expect(updated.markdown).toBe('ONE\nthree 2\n')
    const versions = (await s.storage.listRevisions(ids.shared)).length
    for (const [patches, code] of [
      [[{ find: 'missing', replace: 'x' }], 'E_AI_PATCH_NOT_FOUND'],
      [[{ find: 'e', replace: 'x' }], 'E_AI_PATCH_AMBIGUOUS'],
      // A later patch failing leaves the earlier ones unwritten.
      [
        [
          { find: 'ONE', replace: 'x' },
          { find: 'ONE', replace: 'y' },
        ],
        'E_AI_PATCH_NOT_FOUND',
      ],
      [[], 'E_AI_PATCHES_INVALID'],
      [[{ find: '', replace: 'x' }], 'E_AI_PATCHES_INVALID'],
    ] as const) {
      await expect(s.ai.update({ id: ids.shared, body: { patches } })).rejects.toThrow(code)
    }
    expect((await s.ai.read(ids.shared)).markdown).toBe('ONE\nthree 2\n')
    expect((await s.storage.listRevisions(ids.shared)).length).toBe(versions)
  })

  it('patches a note larger than one call may send, but limits what is sent', async () => {
    const s = setup()
    const { books } = await world(s)
    const big = `Head.\n${'x'.repeat(MAX_AI_BODY_BYTES + 10)}\n`
    const id = await note(s, 'Big', big, books.shared)
    const updated = await s.ai.update({
      id,
      body: { patches: [{ find: 'Head.', replace: 'Top.' }] },
    })
    expect(updated.markdown.startsWith('Top.\n')).toBe(true)
    await expect(
      s.ai.update({
        id,
        body: { patches: [{ find: 'Top.', replace: 'y'.repeat(MAX_AI_BODY_BYTES + 1) }] },
      }),
    ).rejects.toThrow('E_NOTE_BODY_TOO_LARGE')
  })

  it('answers hidden notes as unknown, and moves notes only to allowed notebooks', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    for (const key of HIDDEN_NOTES) {
      await expect(s.ai.update({ id: ids[key], title: 'x' })).rejects.toThrow('E_NOTE_NOT_FOUND')
      await expect(s.ai.trash(ids[key])).rejects.toThrow('E_NOTE_NOT_FOUND')
    }
    await expect(s.ai.update({ id: 'nope', title: 'x' })).rejects.toThrow('E_NOTE_NOT_FOUND')
    for (const notebook of [books.priv, books.inside, books.gone, 'Private', 'Inside']) {
      await expect(s.ai.update({ id: ids.shared, title: 'Moved', notebook })).rejects.toThrow(
        'E_BOOK_NOT_FOUND',
      )
    }
    expect(await s.ai.read(ids.shared)).toMatchObject({
      title: 'Shared kiwi',
      notebook: { id: books.shared },
    })
    expect((await s.notes.read(ids.priv)).title).toBe('Private kiwi')
  })

  it('refuses an empty update and bad values before writing anything', async () => {
    const s = setup()
    const { ids } = await world(s)
    await expect(s.ai.update({ id: ids.shared })).rejects.toThrow('E_AI_UPDATE_EMPTY')
    await expect(s.ai.update({ id: ids.shared, title: 'a\nb' })).rejects.toThrow(
      'E_NOTE_TITLE_INVALID',
    )
    await expect(s.ai.update({ id: ids.shared, status: 'later' as never })).rejects.toThrow(
      'E_NOTE_STATUS_INVALID',
    )
    await expect(s.ai.update({ id: ids.shared, tags: ['ok', ' '] })).rejects.toThrow(
      'E_TAG_NAME_INVALID',
    )
    const many = Array.from({ length: MAX_AI_TAGS + 1 }, (_, i) => `t${i}`)
    await expect(s.ai.update({ id: ids.shared, tags: many })).rejects.toThrow('E_AI_TAGS_TOO_MANY')
    await expect(
      s.ai.update({ id: ids.shared, body: { markdown: 'x'.repeat(MAX_AI_BODY_BYTES + 1) } }),
    ).rejects.toThrow('E_NOTE_BODY_TOO_LARGE')
    expect(await s.ai.read(ids.shared)).toMatchObject({ title: 'Shared kiwi', tags: [] })
    expect(await s.tags.list()).toEqual([])
  })

  it('sets the tags by name, reusing tags in any case and creating new ones', async () => {
    const s = setup()
    const { ids } = await world(s)
    const work = await s.tags.addToNote(ids.priv, 'Work')
    const updated = await s.ai.update({ id: ids.shared, tags: ['work', ' Fresh ', 'fresh'] })
    expect(updated.tags).toEqual(['Fresh', 'Work'])
    const all = await s.tags.list()
    expect(all.map((t) => t.name).sort()).toEqual(['Fresh', 'Work'])
    expect(all.find((t) => t.name === 'Work')?.id).toBe(work)

    expect((await s.ai.update({ id: ids.shared, tags: ['Work'] })).tags).toEqual(['Work'])
    expect((await s.ai.update({ id: ids.shared, tags: [] })).tags).toEqual([])
    expect(await s.storage.noteTags(ids.priv)).toEqual([{ id: work, name: 'Work' }])
  })

  it('merges with edits the app holds of the open note', async () => {
    const s = setup()
    const { ids } = await world(s)
    // The app holds the note, with typing not saved yet.
    s.notes.hold(ids.shared)
    await s.notes.insertAt(ids.shared, null, ' Typed in the app.')
    await s.ai.update({
      id: ids.shared,
      body: { patches: [{ find: 'A shared', replace: 'An edited' }] },
    })
    await s.notes.mergeStored()
    await s.notes.flush()
    const expected = 'An edited kiwi note. Typed in the app.'
    expect((await s.notes.read(ids.shared)).bodyMd).toBe(expected)
    expect((await s.storage.getNote(ids.shared))!.bodyMd).toBe(expected)
    s.notes.unhold(ids.shared)
  })
})

describe('trashing notes', () => {
  it('moves a visible note to the Trash, where the app can restore it', async () => {
    const s = setup()
    const { ids } = await world(s)
    expect(await s.ai.trash(ids.shared)).toEqual({ id: ids.shared, title: 'Shared kiwi' })
    await expect(s.ai.read(ids.shared)).rejects.toThrow('E_NOTE_NOT_FOUND')
    await expect(s.ai.trash(ids.shared)).rejects.toThrow('E_NOTE_NOT_FOUND')
    expect((await s.notes.listTrash()).map((n) => n.id)).toContain(ids.shared)
    // Never purged: the note and its body stay.
    await s.notes.restore(ids.shared)
    expect((await s.ai.read(ids.shared)).markdown).toBe('A shared kiwi note.')
  })
})

describe('listing tags', () => {
  it('lists only tags on visible notes, with how many carry each', async () => {
    const s = setup()
    const { books, ids } = await world(s)
    const second = await note(s, 'Second', 'Another.', books.shared)
    await s.tags.addToNote(ids.shared, 'kiwi')
    await s.tags.addToNote(second, 'kiwi')
    await s.tags.addToNote(second, 'Alpha')
    for (const key of HIDDEN_NOTES.filter((k) => k !== 'purged')) {
      await s.tags.addToNote(ids[key], `secret-${key}`)
    }
    await s.tags.addToNote(ids.priv, 'kiwi')
    expect(await s.ai.tags()).toEqual([
      { name: 'Alpha', notes: 1 },
      { name: 'kiwi', notes: 2 },
    ])
  })

  it('lists nothing when no notebook allows AI access', async () => {
    const s = setup()
    const priv = await s.books.create('Private', null)
    const id = await note(s, 'Private', 'x', priv)
    await s.tags.addToNote(id, 'secret')
    expect(await s.ai.tags()).toEqual([])
  })
})

describe('creating notebooks', () => {
  it('creates a notebook with AI access on, top level or inside an allowed one', async () => {
    const s = setup()
    const { books } = await world(s)
    const top = await s.ai.createNotebook({ name: '  Projects ' })
    expect(top.name).toBe('Projects')
    const inner = await s.ai.createNotebook({ name: 'Ideas', parent: 'Shared' })
    const all = await s.books.list()
    expect(all.find((b) => b.id === top.id)).toMatchObject({ parentId: null, aiAccess: true })
    expect(all.find((b) => b.id === inner.id)).toMatchObject({
      parentId: books.shared,
      aiAccess: true,
    })
    expect((await s.ai.notebooks()).map((b) => b.name)).toEqual(['Shared', 'Ideas', 'Projects'])
    const created = await s.ai.create({ title: 'Plan', markdown: 'x', notebook: 'Ideas' })
    expect(created.notebook.id).toBe(inner.id)
  })

  it('refuses hidden parents, names AI already sees and bad names', async () => {
    const s = setup()
    const { books } = await world(s)
    for (const parent of [books.priv, books.inside, books.gone, 'Private']) {
      await expect(s.ai.createNotebook({ name: 'X', parent })).rejects.toThrow('E_BOOK_NOT_FOUND')
    }
    await expect(s.ai.createNotebook({ name: 'Shared' })).rejects.toThrow('E_BOOK_NAME_TAKEN')
    await expect(s.ai.createNotebook({ name: ' ' })).rejects.toThrow('E_BOOK_NAME_INVALID')
    // A hidden notebook's name is no reason to refuse: that would reveal it.
    const named = await s.ai.createNotebook({ name: 'Private' })
    expect(named.name).toBe('Private')
    expect((await s.books.list()).filter((b) => b.name === 'X')).toEqual([])
  })
})

describe('applyPatches', () => {
  it('applies patches in turn, line breaks as \\n', () => {
    expect(applyPatches('a b c', [{ find: 'b', replace: 'B' }])).toBe('a B c')
    expect(applyPatches('x\ny', [{ find: 'x\r\ny', replace: 'z' }])).toBe('z')
    // Overlapping matches count as two.
    expect(() => applyPatches('aaa', [{ find: 'aa', replace: 'b' }])).toThrow(
      'E_AI_PATCH_AMBIGUOUS',
    )
    const many = Array.from({ length: MAX_AI_PATCHES + 1 }, () => ({ find: 'a', replace: 'a' }))
    expect(() => applyPatches('a', many)).toThrow('E_AI_PATCHES_INVALID')
  })
})

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
      writer: () => WRITER,
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
