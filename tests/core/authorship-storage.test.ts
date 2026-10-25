// Authorship on real SQLite (ADR 0007): devot-mcp writes through its own connection to the file the
// app's note service uses, as on a Mac running both. The records live in each note's Yjs state and
// the agent_writes index beside it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  attribute,
  BODY,
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  newWriter,
  readWrites,
  WRITERS,
  WRITES,
  type AiService,
  type StorageAdapter,
} from '../../src/core'
import { AGENT_WRITES_SQL, openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'
import { tempDir } from '../support/temp-dirs'

const CLAUDE = newWriter('mcp', 'Claude Code', 'mcp00aa11bb22cc')
const CODEX = newWriter('mcp', 'Codex', 'mcp33dd44ee55ff')

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const adapter = (path: string, migrate = true) => {
  const storage = openSqliteAdapter(path, { migrate })
  open.push(storage)
  return storage
}

function app(path: string) {
  const storage = adapter(path)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const logs: string[] = []
  const notes = createNoteService({
    storage,
    clock,
    newId,
    saveDelayMs: 5,
    log: (...parts) => logs.push(parts.join(' ')),
  })
  return { storage, notes, books: createBookService({ storage, clock, newId }), logs }
}

/** devot-mcp: a connection of its own to the same file, for one client. */
function mcp(
  path: string,
  writer = CLAUDE,
): { ai: AiService; storage: SqliteAdapter; logs: string[] } {
  const storage = adapter(path, false)
  const logs: string[] = []
  const ai = createAiService({
    storage,
    clock: createClock(writer.process),
    newId: createIdGenerator(),
    atomically: storage.atomically,
    writer: () => writer,
    log: (...parts) => logs.push(parts.join(' ')),
  })
  return { ai, storage, logs }
}

async function setup() {
  const path = join(tempDir('devot-authorship-'), 'devot.sqlite')
  const a = app(path)
  const shared = await a.books.create('Shared', null, { aiAccess: true })
  return { path, ...a, shared, claude: mcp(path), codex: mcp(path, CODEX) }
}

const docOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

/** The agents' text in the document, run by run. */
const agentText = (doc: Y.Doc) => {
  const body = doc.getText(BODY).toString()
  return attribute(doc).map((run) => body.slice(run.from, run.to))
}

const rows = (storage: SqliteAdapter, noteId: string) =>
  storage.db
    .prepare('SELECT write_id, kind, name, created, seen FROM agent_writes WHERE note_id = ?')
    .all(noteId) as {
    write_id: string
    kind: string
    name: string
    created: number
    seen: number
  }[]

const stored = async (storage: SqliteAdapter, id: string) => {
  const note = await storage.getNote(id, { trashed: true })
  if (!note) throw new Error('E_TEST_NO_NOTE')
  return docOf(note.ydoc)
}

describe('recording agent writes', () => {
  it('stores the record with the body and its row in devot-mcp’s own transaction', async () => {
    const s = await setup()
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: 'Monday\n',
      notebook: s.shared,
    })
    // Before the app has done anything: devot-mcp wrote the row itself.
    expect(rows(s.claude.storage, id)).toEqual([
      { write_id: expect.any(String), kind: 'mcp', name: 'Claude Code', created: 1, seen: 0 },
    ])
    const doc = await stored(s.storage, id)
    expect(readWrites(doc)).toEqual([
      expect.objectContaining({ session: CLAUDE.session, created: true, removed: undefined }),
    ])
    expect(agentText(doc)).toEqual(['Monday\n'])
    expect(await s.storage.listAgentWrites(10)).toEqual([
      expect.objectContaining({ noteId: id, kind: 'mcp', name: 'Claude Code', seen: false }),
    ])
  })

  it('records which metadata a write changed, and nothing for a write that changes nothing', async () => {
    const s = await setup()
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: 'Text\n',
      notebook: s.shared,
    })
    await s.claude.ai.update({ id, title: 'Plan', body: { markdown: 'Text\n' } })
    await s.claude.ai.update({ id, title: 'Renamed', status: 'active', tags: ['work'] })
    const writes = readWrites(await stored(s.storage, id))
    expect(writes.map((w) => w.fields)).toEqual([[], ['title', 'tags', 'status']])
    await s.claude.ai.trash(id)
    expect(readWrites(await stored(s.storage, id)).at(-1)!.fields).toEqual(['trash'])
    // The Trash keeps the rows; the list leaves them out.
    expect(rows(s.storage, id)).toHaveLength(3)
    expect(await s.storage.listAgentWrites(10)).toEqual([])
  })

  it('logs codes, note IDs, write IDs and kinds, never a name or text', async () => {
    const s = await setup()
    const warn = vi.spyOn(console, 'warn')
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: 'Secret words\n',
      notebook: s.shared,
    })
    const [write] = readWrites(await stored(s.storage, id))
    expect(s.claude.logs).toEqual([`I_AUTHORSHIP_WRITE ${id} ${write!.id} mcp`])
    await s.notes.undoAgentWrites(id, { kind: 'mcp', name: 'Claude Code' })
    await s.notes.clearAuthorship(id)
    expect(s.logs).toEqual([`I_AUTHORSHIP_UNDONE ${id} 1`, `I_AUTHORSHIP_CLEARED ${id}`])
    const all = [...s.claude.logs, ...s.logs, ...warn.mock.calls.flat().map(String)].join('\n')
    expect(all).not.toMatch(/Secret|Claude Code/)
    warn.mockRestore()
  })
})

/** The owner types in the editor: its replica's update, inserted after `after`. */
async function type(
  notes: ReturnType<typeof app>['notes'],
  id: string,
  after: string,
  text: string,
) {
  const replica = docOf((await notes.open(id)).state)
  const body = replica.getText(BODY)
  const at = body.toString().indexOf(after)
  if (at < 0) throw new Error('E_TEST_NOT_FOUND')
  const updates: Uint8Array[] = []
  replica.on('update', (u: Uint8Array) => updates.push(u))
  body.insert(at + after.length, text)
  await notes.applyUpdate(id, Y.mergeUpdates(updates))
}

describe('interleaved owner and agent edits', () => {
  async function interleaved() {
    const s = await setup()
    const id = await s.notes.create('Plan', s.shared)
    s.notes.hold(id)
    await s.notes.setBody(id, 'Intro.\n')
    await s.notes.flush()
    await s.claude.ai.update({
      id,
      body: { patches: [{ find: 'Intro.', replace: 'Intro.\n\nThe agent adds this paragraph.' }] },
    })
    await s.notes.mergeStored()
    // The owner types inside the agent's paragraph, then after it.
    await type(s.notes, id, 'adds ', 'really ')
    await type(s.notes, id, 'paragraph.\n', "The owner's own line.\n")
    await s.notes.flush()
    await s.codex.ai.update({
      id,
      body: {
        patches: [{ find: "owner's own line.", replace: "owner's own line.\nCodex was here." }],
      },
    })
    await s.notes.mergeStored()
    await s.claude.ai.update({
      id,
      body: { patches: [{ find: 'Intro.', replace: 'Introduction.' }] },
    })
    await s.notes.mergeStored()
    await s.notes.flush()
    return { ...s, id }
  }

  it('attributes each agent’s text and leaves the owner’s typing the owner’s', async () => {
    const s = await interleaved()
    const doc = docOf((await s.notes.open(s.id)).state)
    expect(doc.getText(BODY).toString()).toBe(
      "Introduction.\n\nThe agent adds really this paragraph.\nThe owner's own line.\nCodex was here.\n",
    )
    const writers = readWrites(doc).map((w) => w.session)
    expect(writers).toEqual([CLAUDE.session, CODEX.session, CLAUDE.session])
    expect(agentText(doc)).toEqual([
      'duction',
      '\nThe agent adds ',
      'this paragraph.\n',
      'Codex was here.\n',
    ])
  })

  it('Undo All reverts one agent and keeps the owner’s later edits and the other agent’s text', async () => {
    const s = await interleaved()
    const result = await s.notes.undoAgentWrites(s.id, { kind: 'mcp', name: 'Claude Code' })
    expect(result).toMatchObject({ writes: 2, dropped: 0 })
    await s.notes.flush()
    const doc = await stored(s.storage, s.id)
    const body = doc.getText(BODY).toString()
    expect(body).toContain('Intro.\n')
    expect(body).not.toMatch(/Introduction|agent adds|paragraph/)
    expect(body).toContain('really')
    expect(body).toContain("The owner's own line.\nCodex was here.\n")
    expect(readWrites(doc).map((w) => w.session)).toEqual([CODEX.session])
    expect(rows(s.storage, s.id).map((r) => r.name)).toEqual(['Codex'])
    // The editor's replica takes the reversal as one update and ends as the core's document.
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(docOf((await s.notes.open(s.id)).state)))
    expect(replica.getText(BODY).toString()).toBe(body)
    // The text before the reversal is kept as a version.
    const versions = (await s.storage.listRevisions(s.id)).filter((r) => r.kind === 'body')
    const latest = await s.storage.getRevision(versions[0]!.id)
    expect(docOf(latest!.ydoc!).getText(BODY).toString()).toContain('Introduction.')
  })

  it('keeps the authorship through a restart', async () => {
    const s = await interleaved()
    const before = agentText(docOf((await s.notes.open(s.id)).state))
    s.notes.unhold(s.id)
    for (const a of open.splice(0)) a.close()
    const again = app(s.path)
    const doc = docOf((await again.notes.open(s.id)).state)
    expect(agentText(doc)).toEqual(before)
    await again.notes.undoAgentWrites(s.id, { kind: 'mcp', name: 'Codex' })
    await again.notes.flush()
    expect(agentText(await stored(again.storage, s.id)).join('')).not.toContain('Codex')
  })
})

describe('revisions', () => {
  it('keeps the records in each body version, and compaction leaves the note’s authorship alone', async () => {
    const s = await setup()
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: 'One.\n',
      notebook: s.shared,
    })
    for (const [i, word] of ['Two', 'Three', 'Four'].entries()) {
      await s.claude.ai.update({
        id,
        body: { patches: [{ find: 'One.', replace: `One. ${word}.` }] },
      })
      await s.notes.setBody(id, `${(await s.notes.read(id)).bodyMd}Owner ${i}.\n`)
      await s.notes.flush({ versions: true })
    }
    const note = await stored(s.storage, id)
    const versions = (await s.storage.listRevisions(id)).filter((r) => r.kind === 'body')
    expect(versions.length).toBeGreaterThan(2)
    const latest = await s.storage.getRevision(versions[0]!.id)
    expect(agentText(docOf(latest!.ydoc!))).toEqual(agentText(note))
    await s.storage.compactRevisions(
      versions.slice(1).map((v) => v.id),
      Date.now(),
    )
    expect((await s.storage.listRevisions(id)).length).toBeLessThan(versions.length)
    expect(agentText(await stored(s.storage, id))).toEqual(agentText(note))
    expect(rows(s.storage, id)).toHaveLength(4)
  })
})

describe('the agent_writes index', () => {
  it('starts rows unseen, Edit with AI rows seen, and keeps seen through later writes', async () => {
    const s = await setup()
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: 'Draft text.\n',
      notebook: s.shared,
    })
    const [first] = await s.storage.listAgentWrites(10)
    await s.storage.markAgentWritesSeen(id, [first!.writeId, 'unknown0000'])
    await s.claude.ai.update({ id, body: { markdown: 'Draft text, longer.\n' } })
    await s.notes.applyAiEdit(id, { from: 0, original: 'Draft', replacement: 'Final' })
    await s.notes.flush()
    const listed = await s.storage.listAgentWrites(10)
    expect(listed.map((w) => [w.kind, w.name, w.seen])).toEqual([
      ['aiEdit', '', true],
      ['mcp', 'Claude Code', false],
      ['mcp', 'Claude Code', true],
    ])
    expect(await s.storage.listAgentWrites(1)).toHaveLength(1)
    const [aiEdit] = readWrites(await stored(s.storage, id)).slice(-1)
    const writers = (await stored(s.storage, id)).getMap(WRITERS).toJSON()
    expect(writers[aiEdit!.session]).toEqual({ v: 1, kind: 'aiEdit', name: '', process: 'mac1' })
  })

  it('derives missing rows again on the note’s next write, and purging deletes them', async () => {
    const s = await setup()
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: 'Text.\n',
      notebook: s.shared,
    })
    s.storage.db.prepare('DELETE FROM agent_writes').run()
    await s.notes.setBody(id, 'Text. More.\n')
    await s.notes.flush()
    expect(rows(s.storage, id)).toHaveLength(1)
    await s.notes.trash(id)
    await s.notes.purge(id)
    expect(rows(s.storage, id)).toEqual([])
  })

  it('refuses rows note_put would refuse', async () => {
    const s = await setup()
    const id = await s.notes.create('Plan')
    const note = (await s.storage.getNote(id))!
    const row = { writeId: 'AAAAAAAAAAA', kind: 'mcp' as const, name: 'x', at: 1, created: false }
    for (const bad of [
      { ...row, writeId: 'short' },
      { ...row, kind: 'owner' as 'mcp' },
      { ...row, name: 'two\nlines' },
      { ...row, name: 'n'.repeat(101) },
      { ...row, at: -1 },
    ]) {
      await expect(s.storage.putNote({ ...note, agentWrites: [bad] })).rejects.toThrow(
        'E_NOTE_WRITES_INVALID',
      )
    }
    await expect(s.storage.putNote({ ...note, agentWrites: [row, row] })).rejects.toThrow(
      'E_NOTE_WRITES_INVALID',
    )
  })
})

describe('Clear Authorship', () => {
  it('drops every record and row, and the stored state shrinks', async () => {
    const s = await setup()
    const long = 'A sentence the agent will delete. '.repeat(400)
    const { id } = await s.claude.ai.create({
      title: 'Plan',
      markdown: `${long}\nKept.\n`,
      notebook: s.shared,
    })
    await s.claude.ai.update({ id, body: { markdown: 'Kept.\n' } })
    const before = (await s.storage.getNote(id))!.ydoc.length
    await s.notes.clearAuthorship(id)
    await s.notes.flush()
    const doc = await stored(s.storage, id)
    expect(doc.getMap(WRITES).size).toBe(0)
    expect(doc.getMap(WRITERS).size).toBe(0)
    expect(attribute(doc)).toEqual([])
    expect(rows(s.storage, id)).toEqual([])
    expect((await s.storage.getNote(id))!.ydoc.length).toBeLessThan(before - long.length / 2)
    expect(s.logs).toContain(`I_AUTHORSHIP_CLEARED ${id}`)
  })
})

describe('the deleted-text cap', () => {
  it('keeps at most 1 MiB of deleted text per note, dropping the oldest first', async () => {
    const s = await setup()
    const half = `${'Seven hundred kilobytes of words. '.repeat(20_000)}\n`
    const { id } = await s.claude.ai.create({ title: 'Big', markdown: half, notebook: s.shared })
    await s.claude.ai.update({ id, body: { markdown: 'Gone.\n' } })
    await s.claude.ai.update({ id, body: { markdown: half } })
    await s.claude.ai.update({ id, body: { markdown: 'Gone again.\n' } })
    const writes = readWrites(await stored(s.storage, id))
    // The first deletion went: the two after it hold what they deleted.
    expect(writes.map((w) => w.removed !== undefined)).toEqual([false, false, true, true])
    expect(writes[1]!.deleted.length).toBeGreaterThan(0)
    const result = await s.notes.undoAgentWrites(id, { kind: 'mcp', name: 'Claude Code' })
    expect(result).toMatchObject({ writes: 4, dropped: 1 })
  })
})

describe('the statements', () => {
  it('runs the same statements as the Rust store', () => {
    const rust = readFileSync('src-tauri/src/storage/mod.rs', 'utf8')
    const statement = (name: string) =>
      new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(rust)?.[1] ?? ''
    const words = (sql: string) => sql.split(/\s+/).join(' ')
    const names: Record<keyof typeof AGENT_WRITES_SQL, string> = {
      keep: 'AGENT_WRITES_KEEP_SQL',
      put: 'AGENT_WRITES_PUT_SQL',
      list: 'AGENT_WRITES_LIST_SQL',
      seen: 'AGENT_WRITES_SEEN_SQL',
      purge: 'AGENT_WRITES_PURGE_SQL',
    }
    const keys = Object.keys(names) as (keyof typeof names)[]
    const rusts = Object.fromEntries(keys.map((k) => [k, words(statement(names[k]))]))
    expect(rusts).toEqual(Object.fromEntries(keys.map((k) => [k, words(AGENT_WRITES_SQL[k])])))
  })

  it('lists from the index and reads no note’s state', async () => {
    const s = await setup()
    const plan = (
      s.storage.db.prepare(`EXPLAIN QUERY PLAN ${AGENT_WRITES_SQL.list}`).all({ limit: 1 }) as {
        detail: string
      }[]
    )
      .map((p) => p.detail)
      .join('\n')
    expect(plan).toMatch(/agent_writes_newest/)
    expect(plan).not.toMatch(/TEMP B-TREE/)
  })
})

describe('the UI tests’ memory adapter', () => {
  afterEach(() => restoreLocalStorage())

  it('keeps the agent_writes rows as SQLite does', async () => {
    useMemoryLocalStorage()
    const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
    const run = async (storage: StorageAdapter) => {
      const clock = createClock('mac1')
      const newId = createIdGenerator()
      let time = 1_790_000_000_000
      const now = () => (time += 1000)
      const notes = createNoteService({ storage, clock, newId, now, saveDelayMs: 5 })
      const id = await notes.create('Plan')
      const other = await notes.create('Other')
      await notes.agentWrite(id, { writer: CLAUDE, markdown: 'One.\n' })
      await notes.agentWrite(other, { writer: CODEX, markdown: 'Two.\n' })
      await notes.flush()
      const [first] = await storage.listAgentWrites(10)
      await storage.markAgentWritesSeen(first!.noteId, [first!.writeId])
      await notes.applyAiEdit(id, { from: 0, original: 'One', replacement: 'Uno' })
      await notes.agentWrite(id, { writer: CLAUDE, markdown: 'Uno. Dos.\n' })
      await notes.trash(other)
      await notes.flush()
      return (await storage.listAgentWrites(10)).map((w) => [
        w.noteId === id,
        w.kind,
        w.name,
        w.seen,
      ])
    }
    const expected = await run(adapter(join(tempDir('devot-authorship-'), 'devot.sqlite')))
    expect(expected).toHaveLength(3)
    expect(await run(memoryStorage)).toEqual(expected)
  })
})
