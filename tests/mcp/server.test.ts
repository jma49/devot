// devot-mcp's tools through an MCP client on a real database: notes outside notebooks with Allow AI Access,
// in the trash or in no notebook are invisible to every tool.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createAiService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  readWrites,
  WRITERS,
} from '../../src/core'
import { clientWriter, createServer, errorCode } from '../../src/mcp/server'
import { openSqliteAdapter } from '../../src/mcp/sqlite'
import { HIDDEN, makeWorld } from './support'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const FILE = '0192a6f0-0000-7000-8000-00000000f001'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done()
})

async function connect(path: string, clientName = 'test') {
  const storage = openSqliteAdapter(path, { migrate: false })
  const logs: string[] = []
  const server = createServer({ service: () => ai, log: (...parts) => logs.push(parts.join(' ')) })
  const ai = createAiService({
    storage,
    clock: createClock('mcptest'),
    newId: createIdGenerator(),
    atomically: storage.atomically,
    writer: clientWriter(server, 'mcptest'),
  })
  const client = new Client({ name: clientName, version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  cleanup.push(
    () => storage.close(),
    () => client.close(),
  )
  return { client, storage, logs }
}

interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult
  const text = result.content[0]?.text ?? ''
  if (result.isError) return { error: text }
  return { value: JSON.parse(text) as Record<string, unknown> }
}

describe('devot-mcp tools', () => {
  it('offers reading, creating, editing and trashing tools', async () => {
    const world = await makeWorld()
    const { client } = await connect(world.path)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_note',
      'create_notebook',
      'list_notebooks',
      'list_tags',
      'read_note',
      'search_notes',
      'trash_note',
      'update_note',
    ])
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)
    expect(readOnly.sort()).toEqual(['list_notebooks', 'list_tags', 'read_note', 'search_notes'])
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)
    expect(destructive).toEqual(['trash_note'])
    const update = tools.find((t) => t.name === 'update_note')!
    expect(Object.keys(update.inputSchema.properties ?? {}).sort()).toEqual([
      'id',
      'markdown',
      'notebook',
      'patches',
      'status',
      'tags',
      'title',
    ])
    expect(update.inputSchema.required).toEqual(['id'])
  })

  it('lists only notebooks with AI access', async () => {
    const world = await makeWorld()
    const { client } = await connect(world.path)
    expect(await call(client, 'list_notebooks')).toEqual({
      value: { notebooks: [{ id: world.books.shared, name: 'Shared', notes: 1 }] },
    })
  })

  it('finds and reads only visible notes', async () => {
    const world = await makeWorld()
    const { client } = await connect(world.path)
    const found = await call(client, 'search_notes', { query: 'kiwi' })
    const results = (found.value?.['results'] ?? []) as {
      id: string
      snippet: string
      updatedAt: string
    }[]
    expect(results.map((r) => r.id)).toEqual([world.ids.shared])
    expect(results[0]?.snippet).toBe('A shared kiwi note.')
    expect(results[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const read = await call(client, 'read_note', { id: world.ids.shared })
    expect(read.value).toMatchObject({
      id: world.ids.shared,
      title: 'Shared kiwi',
      markdown: 'A shared kiwi note.',
      notebook: { id: world.books.shared, name: 'Shared' },
    })
  })

  it('never returns a hidden note from any tool, and the errors give nothing away', async () => {
    const world = await makeWorld()
    const { client } = await connect(world.path)
    const listed = JSON.stringify(await call(client, 'list_notebooks'))
    for (const key of HIDDEN) {
      const id = world.ids[key]
      expect(await call(client, 'read_note', { id })).toEqual({
        error: 'E_NOTE_NOT_FOUND: No note with this ID is available to AI.',
      })
      expect(listed).not.toContain(id)
      const search = JSON.stringify(await call(client, 'search_notes', { query: 'kiwi' }))
      expect(search).not.toContain(id)
    }
    expect(await call(client, 'read_note', { id: '0192a6f0-0000-7000-8000-000000000999' })).toEqual(
      { error: 'E_NOTE_NOT_FOUND: No note with this ID is available to AI.' },
    )
    for (const notebook of [world.books.inside, world.books.priv, world.books.gone, 'Private']) {
      expect(listed).not.toContain(notebook)
      const made = await call(client, 'create_note', { title: 'X', markdown: 'y', notebook })
      expect(made.error).toMatch(/^E_BOOK_NOT_FOUND: /)
    }
  })

  it('creates a note through Yjs in an allowed notebook, by name or ID', async () => {
    const world = await makeWorld()
    const { client, storage, logs } = await connect(world.path)
    const made = await call(client, 'create_note', {
      title: 'Meeting notes',
      markdown: '# Agenda\n\n1. Kiwi harvest\n',
      notebook: 'Shared',
    })
    const id = made.value?.['id'] as string
    expect(made.value).toEqual({
      id,
      title: 'Meeting notes',
      notebook: { id: world.books.shared, name: 'Shared' },
    })
    const record = (await storage.getNote(id))!
    const doc = new Y.Doc()
    Y.applyUpdate(doc, record.ydoc)
    expect(doc.getText(BODY).toString()).toBe('# Agenda\n\n1. Kiwi harvest\n')
    expect(record.bodyMd).toBe('# Agenda\n\n1. Kiwi harvest\n')
    expect(logs).toEqual([`I_MCP_NOTE_CREATED ${id} ${world.books.shared}`])

    const again = await call(client, 'search_notes', { query: 'harvest' })
    expect(((again.value?.['results'] ?? []) as { id: string }[]).map((r) => r.id)).toEqual([id])
    const byId = await call(client, 'create_note', {
      title: 'Second',
      markdown: '',
      notebook: world.books.shared,
    })
    expect(byId.value?.['notebook']).toEqual({ id: world.books.shared, name: 'Shared' })
  })

  it('makes a note whose images stay when the note it read them from is deleted for good', async () => {
    const world = await makeWorld()
    const app = openSqliteAdapter(world.path)
    cleanup.push(() => app.close())
    const notes = createNoteService({
      storage: app,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const source = await notes.create('Shot', world.books.shared)
    await app.putFile({ id: FILE, noteId: source, name: 'shot.png' }, PNG)
    await notes.setBody(source, `# Shot\n\n![shot](devot://file/${FILE}#half)\n`)
    await notes.release(source)

    const { client } = await connect(world.path)
    const read = await call(client, 'read_note', { id: source })
    const made = await call(client, 'create_note', {
      title: 'Shot again',
      markdown: read.value?.['markdown'],
      notebook: 'Shared',
    })
    const id = made.value?.['id'] as string
    expect((await app.getNote(id))?.bodyMd).toContain(`devot://file/${FILE}#half`)

    await notes.trash(source)
    await notes.purge(source)
    const file = app.db.prepare('SELECT note_id AS noteId FROM files WHERE id = ?').get(FILE)
    expect(file).toEqual({ noteId: id })
  })

  it('reports failures as codes, logged without content', async () => {
    const world = await makeWorld()
    const { client, logs } = await connect(world.path)
    const bad = await call(client, 'create_note', {
      title: 'secret\ntitle',
      markdown: 'secret body',
      notebook: 'Shared',
    })
    expect(bad.error).toMatch(/^E_NOTE_TITLE_INVALID: /)
    expect((await call(client, 'search_notes', { query: '""' })).error).toMatch(
      /^E_SEARCH_QUERY_EMPTY: /,
    )
    expect(logs).toEqual([
      'W_MCP_TOOL_FAILED create_note E_NOTE_TITLE_INVALID',
      'W_MCP_TOOL_FAILED search_notes E_SEARCH_QUERY_EMPTY',
    ])
    expect(logs.join('\n')).not.toContain('secret')
  })
})

describe('editing tools', () => {
  it('updates a visible note by patch, with tags and status, and logs only its ID', async () => {
    const world = await makeWorld()
    const { client, storage, logs } = await connect(world.path)
    const updated = await call(client, 'update_note', {
      id: world.ids.shared,
      patches: [{ find: 'shared kiwi', replace: 'edited kiwi' }],
      tags: ['fruit'],
      status: 'completed',
    })
    expect(updated.value).toMatchObject({
      id: world.ids.shared,
      markdown: 'A edited kiwi note.',
      tags: ['fruit'],
      status: 'completed',
    })
    expect(updated.value?.['updatedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((await storage.getNote(world.ids.shared))?.bodyMd).toBe('A edited kiwi note.')
    expect(await call(client, 'list_tags')).toEqual({
      value: { tags: [{ name: 'fruit', notes: 1 }] },
    })
    expect(logs).toEqual([`I_MCP_NOTE_UPDATED ${world.ids.shared}`])
  })

  it('refuses a body given both ways, an empty update and unmatched patches, by code', async () => {
    const world = await makeWorld()
    const { client } = await connect(world.path)
    const id = world.ids.shared
    const both = await call(client, 'update_note', {
      id,
      markdown: 'x',
      patches: [{ find: 'kiwi', replace: 'y' }],
    })
    expect(both.error).toMatch(/^E_AI_BODY_CONFLICT: /)
    expect((await call(client, 'update_note', { id })).error).toMatch(/^E_AI_UPDATE_EMPTY: /)
    const missing = await call(client, 'update_note', {
      id,
      patches: [{ find: 'banana', replace: 'y' }],
    })
    expect(missing.error).toMatch(/^E_AI_PATCH_NOT_FOUND: /)
    const twice = await call(client, 'update_note', { id, patches: [{ find: 'e', replace: 'y' }] })
    expect(twice.error).toMatch(/^E_AI_PATCH_AMBIGUOUS: /)
    const status = await call(client, 'update_note', { id, status: 'later' })
    expect(status.error).toBeDefined()
  })

  it('never edits or trashes a hidden note, and errors give nothing away', async () => {
    const world = await makeWorld()
    const { client, storage } = await connect(world.path)
    for (const key of HIDDEN) {
      const id = world.ids[key]
      expect(await call(client, 'update_note', { id, title: 'Taken' })).toEqual({
        error: 'E_NOTE_NOT_FOUND: No note with this ID is available to AI.',
      })
      expect(await call(client, 'trash_note', { id })).toEqual({
        error: 'E_NOTE_NOT_FOUND: No note with this ID is available to AI.',
      })
    }
    expect((await storage.getNote(world.ids.priv))?.title).toBe('Private kiwi')
    const moved = await call(client, 'update_note', {
      id: world.ids.shared,
      notebook: 'Private',
    })
    expect(moved.error).toMatch(/^E_BOOK_NOT_FOUND: /)
  })

  it('never confirms a tag only hidden notebooks use, and refuses to reuse it', async () => {
    const world = await makeWorld()
    const storage = openSqliteAdapter(world.path)
    try {
      const tags = createTagService({
        storage,
        clock: createClock('mac1'),
        newId: createIdGenerator(),
      })
      await tags.addToNote(world.ids.priv, 'Layoffs-2027')
    } finally {
      storage.close()
    }
    const { client } = await connect(world.path)
    expect((await call(client, 'list_tags')).value?.tags).toEqual([])

    const update = await call(client, 'update_note', {
      id: world.ids.shared,
      tags: ['lAYOFFS-2027', 'nOPE-TAG'],
    })
    expect(update.error).toMatch(/^E_TAG_NAME_INVALID: /)
    expect((await call(client, 'list_tags')).value?.tags).toEqual([])
    expect((await call(client, 'read_note', { id: world.ids.shared })).value?.tags).toEqual([])
  })

  it('trashes a note without deleting it', async () => {
    const world = await makeWorld()
    const { client, storage, logs } = await connect(world.path)
    const trashed = await call(client, 'trash_note', { id: world.ids.shared })
    expect(trashed.value).toEqual({ id: world.ids.shared, title: 'Shared kiwi', trashed: true })
    expect(await storage.getNote(world.ids.shared)).toBeNull()
    expect((await storage.getNote(world.ids.shared, { trashed: true }))?.bodyMd).toBe(
      'A shared kiwi note.',
    )
    expect(logs).toEqual([`I_MCP_NOTE_TRASHED ${world.ids.shared}`])
  })

  it('creates a notebook AI can use at once', async () => {
    const world = await makeWorld()
    const { client, logs } = await connect(world.path)
    const made = await call(client, 'create_notebook', { name: 'Research', parent: 'Shared' })
    const id = made.value?.['id'] as string
    expect(made.value).toEqual({ id, name: 'Research' })
    const listed = await call(client, 'list_notebooks')
    expect(listed.value?.['notebooks']).toEqual([
      { id: world.books.shared, name: 'Shared', notes: 1 },
      { id, name: 'Research', notes: 0 },
    ])
    const hidden = await call(client, 'create_notebook', { name: 'X', parent: 'Private' })
    expect(hidden.error).toMatch(/^E_BOOK_NOT_FOUND: /)
    const taken = await call(client, 'create_notebook', { name: 'Shared' })
    expect(taken.error).toMatch(/^E_BOOK_NAME_TAKEN: /)
    expect(logs[0]).toBe(`I_MCP_NOTEBOOK_CREATED ${id}`)
  })
})

describe('authorship', () => {
  it('records each write as the client named itself, one session for the connection', async () => {
    const world = await makeWorld()
    const { client, storage } = await connect(world.path, ' Claude\nCode ')
    const made = await call(client, 'create_note', {
      title: 'Plan',
      markdown: 'Step one.\n',
      notebook: 'Shared',
    })
    const id = made.value?.['id'] as string
    await call(client, 'update_note', { id, patches: [{ find: 'one', replace: 'two' }] })
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await storage.getNote(id))!.ydoc)
    const writes = readWrites(doc)
    expect(writes).toHaveLength(2)
    expect(new Set(writes.map((w) => w.session)).size).toBe(1)
    expect(doc.getMap(WRITERS).get(writes[0]!.session)).toEqual({
      v: 1,
      kind: 'mcp',
      name: 'Claude Code',
      process: 'mcptest',
    })
    expect((await storage.listAgentWrites(10)).map((w) => [w.kind, w.name, w.created])).toEqual([
      ['mcp', 'Claude Code', false],
      ['mcp', 'Claude Code', true],
    ])
  })
})

describe('opening without migrating', () => {
  it('tells a missing file from one that cannot be opened', () => {
    const dir = tempDir('devot-mcp-')
    expect(() => openSqliteAdapter(join(dir, 'none.sqlite'), { migrate: false })).toThrow(
      /^E_STORAGE_NOT_FOUND$/,
    )
    expect(existsSync(join(dir, 'none.sqlite'))).toBe(false)
    // A folder where the file should be.
    expect(() => openSqliteAdapter(dir, { migrate: false })).toThrow(/^E_STORAGE_OPEN_FAILED$/)
  })
})

describe('errorCode', () => {
  it('keeps codes, maps busy databases and hides everything else', () => {
    expect(errorCode(new Error('E_NOTE_NOT_FOUND'))).toBe('E_NOTE_NOT_FOUND')
    expect(errorCode(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))).toBe(
      'E_STORAGE_BUSY',
    )
    expect(errorCode(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_RECOVERY' }))).toBe(
      'E_STORAGE_BUSY',
    )
    expect(errorCode(Object.assign(new Error('x'), { code: 'SQLITE_BUSYNESS' }))).toBe(
      'E_MCP_INTERNAL',
    )
    expect(errorCode(new Error('near "secret": syntax error'))).toBe('E_MCP_INTERNAL')
    expect(errorCode('E_NOT_AN_ERROR')).toBe('E_MCP_INTERNAL')
  })
})
