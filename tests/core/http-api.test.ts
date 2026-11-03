// The local HTTP API's contract on the core's side, on real SQLite: every call
// Rust routes a request to (tests/support/http-api-calls.json, which the Rust
// router is checked against too) runs through the AI service on storage
// without AI queries of its own, as the app's is, and answers its JSON.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  HTTP_API_OPS,
  HTTP_API_WRITES,
  newWriter,
  readHttpApiRequest,
  runHttpApiCall,
  writerOfCall,
  type HttpApiCall,
  type StorageAdapter,
} from '../../src/core'

import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const HTTP_WRITER = newWriter('http', '', 'mac1api')

interface ContractCase {
  name: string
  method: string
  target: string
  body?: unknown
  status: number
  call: HttpApiCall
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, '../support/http-api-calls.json'), 'utf8'),
) as ContractCase[]

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

/** The app's storage has none of AiStorage's own queries. */
function plain(adapter: SqliteAdapter): StorageAdapter {
  const {
    searchNotesInBooks: _search,
    countNotesInBooks: _count,
    noteTags: _noteTags,
    tagsInBooks: _tags,
    ...rest
  } = adapter
  return rest
}

async function world() {
  const adapter = openSqliteAdapter(join(tempDir('devot-http-api-'), 'devot.sqlite'))
  open.push(adapter)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const books = createBookService({ storage: adapter, clock, newId })
  const notes = createNoteService({ storage: adapter, clock, newId, saveDelayMs: 5 })
  const tags = createTagService({ storage: adapter, clock, newId })
  const shared = await books.create('Shared', null, { aiAccess: true })
  const priv = await books.create('Private', null)
  const note = await notes.create('Kiwi pie', shared)
  await notes.setBody(note, 'Bake a kiwi pie on Sunday.\n')
  await tags.addToNote(note, 'fruit')
  const hidden = await notes.create('Private kiwi', priv)
  await notes.setBody(hidden, 'A private kiwi pie.\n')
  await tags.addToNote(hidden, 'secret')
  await notes.flush()
  await notes.release(note)
  const api = createAiService({
    storage: plain(adapter),
    clock: createClock('mac1api'),
    newId: createIdGenerator(),
    writer: () => HTTP_WRITER,
  })
  const run = (call: HttpApiCall) => runHttpApiCall(api, call)
  return { adapter, notes, shared, priv, note, hidden, run }
}

const withNote = (call: HttpApiCall, id: string): HttpApiCall => ({
  ...call,
  note: call.note === null ? null : call.note.replace('{note}', id),
})

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type World = Awaited<ReturnType<typeof world>>

const sharedRef = (w: World) => ({ id: w.shared, name: 'Shared' })
const readNote = (w: World) => ({
  id: w.note,
  title: 'Kiwi pie',
  notebook: sharedRef(w),
  status: 'none',
  pinned: false,
  tags: ['fruit'],
  createdAt: expect.stringMatching(ISO),
  updatedAt: expect.stringMatching(ISO),
  markdown: 'Bake a kiwi pie on Sunday.\n',
})

/** Each contract case's answer, by name. */
const EXPECTED: Record<string, (w: World) => unknown> = {
  'list notebooks': (w) => ({ notebooks: [{ ...sharedRef(w), notes: 1 }] }),
  'create a notebook': () => ({ id: expect.any(String), name: 'Ideas' }),
  'list tags': () => ({ tags: [{ name: 'fruit', notes: 1 }] }),
  'search notes': (w) => ({
    results: [
      {
        id: w.note,
        title: 'Kiwi pie',
        notebook: sharedRef(w),
        updatedAt: expect.stringMatching(ISO),
        snippet: 'Bake a kiwi pie on Sunday.',
      },
    ],
  }),
  'create a note': (w) => ({ id: expect.any(String), title: 'Plan', notebook: sharedRef(w) }),
  'read a note': readNote,
  'update a note with patches': (w) => ({
    ...readNote(w),
    title: 'Kiwi pie, again',
    tags: ['baking', 'fruit'],
    status: 'active',
    markdown: 'Bake a lime pie on Sunday.\n',
  }),
  "update a note's whole body": (w) => ({ ...readNote(w), markdown: 'A new body.\n' }),
  'append under a heading': (w) => ({
    ...readNote(w),
    markdown: 'Bake a kiwi pie on Sunday.\nAlso lime.\n',
  }),
  'move a note to the Trash': (w) => ({ id: w.note, title: 'Kiwi pie', trashed: true }),
}

describe('every routed call answers its JSON', () => {
  it('covers every call the core knows, each once at least', () => {
    expect(new Set(CASES.map((c) => c.call.op))).toEqual(new Set(HTTP_API_OPS))
    expect(CASES.map((c) => c.name).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const c of CASES) {
      expect(c.status).toBe(c.call.op.endsWith('.create') ? 201 : 200)
      expect(HTTP_API_WRITES.includes(c.call.op)).toBe(c.method !== 'GET')
    }
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (name, c) => {
    const w = await world()
    const answer = await w.run(withNote(c.call, w.note))
    // A round trip through JSON, as Rust sends it on.
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer)
    expect(answer).toEqual(EXPECTED[name]?.(w))
  })

  it('makes the note it answers with, and trashes the note it names', async () => {
    const w = await world()
    const made = (await w.run({
      op: 'notes.create',
      note: null,
      args: { title: 'Plan', markdown: '# Plan\n', notebook: 'Shared' },
    })) as { id: string }
    expect((await w.adapter.getNote(made.id))?.bodyMd).toBe('# Plan\n')
    const rows = await w.adapter.listAgentWrites(10)
    expect(rows.map((r) => [r.noteId, r.kind, r.name, r.created])).toEqual([
      [made.id, 'http', '', true],
    ])
    await w.run({ op: 'notes.trash', note: w.note, args: {} })
    expect(await w.adapter.getNote(w.note)).toBeNull()
    expect(await w.adapter.getNote(w.note, { trashed: true })).not.toBeNull()
  })
})

describe('the API sees only what AI may', () => {
  it('never finds, reads, changes or trashes a note in a notebook without AI access', async () => {
    const w = await world()
    const hidden = w.hidden
    const search = (await w.run({
      op: 'notes.search',
      note: null,
      args: { query: 'private' },
    })) as {
      results: unknown[]
    }
    expect(search.results).toEqual([])
    for (const call of [
      { op: 'notes.read', note: hidden, args: {} },
      { op: 'notes.update', note: hidden, args: { title: 'Mine' } },
      { op: 'notes.append', note: hidden, args: { text: 'Mine' } },
      { op: 'notes.trash', note: hidden, args: {} },
    ] as const) {
      await expect(w.run(call)).rejects.toThrow('E_NOTE_NOT_FOUND')
    }
    await expect(
      w.run({
        op: 'notes.create',
        note: null,
        args: { title: 'x', markdown: '', notebook: w.priv },
      }),
    ).rejects.toThrow('E_BOOK_NOT_FOUND')
    const stored = await w.adapter.getNote(hidden)
    expect(stored?.title).toBe('Private kiwi')
    expect(await w.run({ op: 'tags.list', note: null, args: {} })).toEqual({
      tags: [{ name: 'fruit', notes: 1 }],
    })
  })

  it('appends under a heading as the client, refuses a missing heading, and leaves out what the schema does not know', async () => {
    const w = await world()
    await w.run({
      op: 'notes.update',
      note: w.note,
      args: { markdown: '## Plan\n- kiwi\n\n## Notes\n' },
    })
    const appended = (await w.run({
      op: 'notes.append',
      note: w.note,
      args: { text: '- lime\r\n', heading: 'plan', position: 'append' },
    })) as { markdown: string }
    expect(appended.markdown).toBe('## Plan\n- kiwi\n- lime\n\n## Notes\n')
    const prepended = (await w.run({
      op: 'notes.append',
      note: w.note,
      args: { text: '- first', heading: 'Plan', position: 'prepend', separator: 'newline' },
    })) as { markdown: string }
    expect(prepended.markdown).toBe('## Plan\n- first\n- kiwi\n- lime\n\n## Notes\n')
    await expect(
      w.run({ op: 'notes.append', note: w.note, args: { text: 'x', heading: 'Missing' } }),
    ).rejects.toThrow('E_HEADING_NOT_FOUND')
    await expect(w.run({ op: 'notes.append', note: w.note, args: { text: '\n' } })).rejects.toThrow(
      'E_APPEND_TEXT_EMPTY',
    )
    for (const args of [
      { text: 1 },
      { text: 'x', position: 'middle' },
      { text: 'x', separator: 'space' },
      { text: 'x', heading: 3 },
    ]) {
      await expect(w.run({ op: 'notes.append', note: w.note, args })).rejects.toThrow(
        'E_HTTP_API_ARGS_INVALID',
      )
    }
    const rows = await w.adapter.listAgentWrites(10)
    expect(rows.filter((r) => r.noteId === w.note).map((r) => r.kind)).toEqual([
      'http',
      'http',
      'http',
    ])
    expect((await w.adapter.getNote(w.note))?.bodyMd).toBe(prepended.markdown)
  })

  it('writes metadata with its own HLCs and keeps the body text it replaced in history', async () => {
    const w = await world()
    await w.run({ op: 'notes.update', note: w.note, args: { title: 'Lime pie' } })
    await w.run({ op: 'notes.update', note: w.note, args: { markdown: 'Gone.\n' } })
    const stored = await w.adapter.getNote(w.note)
    expect(stored?.title).toBe('Lime pie')
    expect(stored?.titleHlc).toContain('mac1api')
    const history = await w.notes.history(w.note)
    const bodies = history.filter((e) => e.kind === 'body')
    expect(bodies.length).toBeGreaterThan(0)
  })
})

describe('the request Rust sends the window', () => {
  it('reads a request with its ID, call, note and arguments', () => {
    expect(readHttpApiRequest({ id: 7, op: 'notes.read', note: 'n', args: {} })).toEqual({
      id: 7,
      call: { op: 'notes.read', note: 'n', args: {} },
    })
  })

  it('refuses any other shape', () => {
    for (const payload of [
      null,
      'notes.read',
      { id: -1, op: 'notes.read', note: null, args: {} },
      { id: 1.5, op: 'notes.read', note: null, args: {} },
      { id: 1, op: 'notes.purge', note: null, args: {} },
      { id: 1, op: 'notes.read', note: 3, args: {} },
      { id: 1, op: 'notes.read', note: null, args: [] },
      { id: 1, op: 'notes.read', note: null },
    ]) {
      expect(readHttpApiRequest(payload)).toBeNull()
    }
  })

  it('refuses arguments of the wrong type with a code', async () => {
    const w = await world()
    for (const call of [
      { op: 'notes.create', note: null, args: { title: 1, markdown: '', notebook: 'Shared' } },
      { op: 'notes.search', note: null, args: { query: 'kiwi', limit: 'many' } },
      { op: 'notes.update', note: w.note, args: { tags: [1] } },
      { op: 'notes.update', note: w.note, args: { status: 'urgent' } },
      { op: 'notes.update', note: w.note, args: { patches: [{ find: 'a' }] } },
      { op: 'notes.read', note: null, args: {} },
    ] as const) {
      await expect(w.run(call)).rejects.toThrow('E_HTTP_API_ARGS_INVALID')
    }
    await expect(
      w.run({ op: 'notes.update', note: w.note, args: { markdown: 'a', patches: [] } }),
    ).rejects.toThrow('E_AI_BODY_CONFLICT')
  })
})

describe('calls of the MCP bridge', () => {
  const SESSION = 'AbCdEfGhIjK'

  it('reads a client from the event, and refuses one that is not shaped as Rust sends it', () => {
    const payload = { id: 1, op: 'tags.list', note: null, args: {} }
    expect(readHttpApiRequest(payload)?.call.client).toBeUndefined()
    const client = { name: 'Claude Code', session: SESSION }
    expect(readHttpApiRequest({ ...payload, client })?.call.client).toEqual(client)
    for (const bad of [
      null,
      3,
      { name: 'x' },
      { name: 3, session: SESSION },
      { name: 'x', session: 'short' },
      { name: 'x', session: 'AbCdEfGhIj!' },
    ]) {
      expect(readHttpApiRequest({ ...payload, client: bad })).toBeNull()
    }
  })

  it('writes as the client, kind mcp, with the bridge run as its session; anything else as http', () => {
    const call: HttpApiCall = { op: 'tags.list', note: null, args: {} }
    expect(writerOfCall(call, HTTP_WRITER)).toBe(HTTP_WRITER)
    expect(
      writerOfCall({ ...call, client: { name: 'Codex', session: SESSION } }, HTTP_WRITER),
    ).toEqual({ session: SESSION, kind: 'mcp', name: 'Codex', process: HTTP_WRITER.process })
  })
})
