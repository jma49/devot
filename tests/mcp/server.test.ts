// devot-mcp's tools through an MCP client, on a real database: notes outside
// notebooks with Allow AI Access, in the trash or in no notebook are
// invisible to every tool.
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
} from '../../src/core'
import { createServer, errorCode } from '../../src/mcp/server'
import { openSqliteAdapter } from '../../src/mcp/sqlite'
import { HIDDEN, makeWorld } from './support'
import { tempDir } from '../support/temp-dirs'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const FILE = '0192a6f0-0000-7000-8000-00000000f001'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done()
})

async function connect(path: string) {
  const storage = openSqliteAdapter(path, { migrate: false })
  const ai = createAiService({
    storage,
    clock: createClock('mcptest'),
    newId: createIdGenerator(),
    atomically: storage.atomically,
  })
  const logs: string[] = []
  const server = createServer({ service: () => ai, log: (...parts) => logs.push(parts.join(' ')) })
  const client = new Client({ name: 'test', version: '1' })
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
  it('offers list, search, read and create', async () => {
    const world = await makeWorld()
    const { client } = await connect(world.path)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_note',
      'list_notebooks',
      'read_note',
      'search_notes',
    ])
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)
    expect(readOnly.sort()).toEqual(['list_notebooks', 'read_note', 'search_notes'])
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
    // An ID that never existed reads the same.
    expect(await call(client, 'read_note', { id: '0192a6f0-0000-7000-8000-000000000999' })).toEqual(
      { error: 'E_NOTE_NOT_FOUND: No note with this ID is available to AI.' },
    )
    // Hidden notebooks are neither listed nor usable.
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
    // Logs carry codes and IDs, never the title or body.
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
    // The app adds a note with an image of its own.
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

    // An assistant reads it and makes a note from its Markdown: the same link, no copy.
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
