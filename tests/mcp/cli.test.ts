// The built devot-mcp CLI, driven over stdio with raw MCP messages, the way
// Claude Code and Claude Desktop run it.
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { build } from 'vite'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openSqliteAdapter, SCHEMA_VERSION } from '../../src/mcp/sqlite'
import { HIDDEN, makeWorld } from './support'
import { tempDir } from '../support/temp-dirs'

// Inside the repository, so the bundle finds better-sqlite3 in node_modules.
const OUT = resolve(import.meta.dirname, '../../dist-mcp-test')
const BUNDLE = join(OUT, 'devot-mcp.mjs')

beforeAll(async () => {
  await build({
    configFile: resolve(import.meta.dirname, '../../vite.mcp.config.ts'),
    logLevel: 'silent',
    build: { outDir: OUT, emptyOutDir: true },
  })
}, 120_000)

interface Message {
  jsonrpc: string
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

const sessions: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of sessions.splice(0)) await close()
})

/** Starts devot-mcp and completes the MCP handshake. */
async function start(args: string[]) {
  const child = spawn(process.execPath, [BUNDLE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout: string[] = []
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const waiting = new Map<number, (message: Message) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    stdout.push(line)
    const message = JSON.parse(line) as Message
    if (message.id !== undefined) waiting.get(message.id)?.(message)
  })
  let next = 1
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method: string, params: object) =>
    new Promise<Message>((done) => {
      const id = next++
      waiting.set(id, done)
      send({ jsonrpc: '2.0', id, method, params })
    })
  const close = async () => {
    if (child.exitCode !== null) return
    child.stdin.end()
    await once(child, 'exit')
  }
  sessions.push(close)

  const hello = await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'devot-test', version: '1' },
  })
  expect(hello.result?.['serverInfo']).toMatchObject({ name: 'devot' })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const tool = async (name: string, input: object = {}) => {
    const reply = await request('tools/call', { name, arguments: input })
    const result = reply.result as unknown as ToolResult
    const text = result.content[0]?.text ?? ''
    return result.isError ? { error: text } : { value: JSON.parse(text) as Record<string, unknown> }
  }
  return { request, tool, stdout, stderr: () => stderr, close }
}

const userVersion = (path: string) => {
  const db = new Database(path)
  try {
    return db.pragma('user_version', { simple: true }) as number
  } finally {
    db.close()
  }
}

const setUserVersion = (path: string, version: number) => {
  const db = new Database(path)
  db.pragma(`user_version = ${version}`)
  db.close()
}

describe('devot-mcp over stdio', () => {
  it('searches, reads and creates notes, seeing only notebooks with AI access', async () => {
    const world = await makeWorld()
    const mcp = await start(['--db', world.path])
    const { result } = await mcp.request('tools/list', {})
    const names = ((result?.['tools'] ?? []) as { name: string }[]).map((t) => t.name).sort()
    expect(names).toEqual(['create_note', 'list_notebooks', 'read_note', 'search_notes'])

    const found = await mcp.tool('search_notes', { query: 'kiwi' })
    expect(((found.value?.['results'] ?? []) as { id: string }[]).map((r) => r.id)).toEqual([
      world.ids.shared,
    ])
    for (const key of HIDDEN) {
      expect((await mcp.tool('read_note', { id: world.ids[key] })).error).toMatch(
        /^E_NOTE_NOT_FOUND: /,
      )
    }
    const read = await mcp.tool('read_note', { id: world.ids.shared })
    expect(read.value?.['markdown']).toBe('A shared kiwi note.')

    const made = await mcp.tool('create_note', {
      title: 'From Claude',
      markdown: 'Picked up by the app.',
      notebook: 'Shared',
    })
    const id = made.value?.['id'] as string
    await mcp.close()

    // The app's side of the file sees the note.
    const app = openSqliteAdapter(world.path)
    try {
      const note = await app.getNote(id)
      expect(note).toMatchObject({
        title: 'From Claude',
        bodyMd: 'Picked up by the app.',
        bookId: world.books.shared,
      })
    } finally {
      app.close()
    }

    // stdout carried MCP messages only; stderr carried codes and IDs only.
    for (const line of mcp.stdout) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
    expect(mcp.stderr()).toContain('devot-mcp I_MCP_STARTED')
    expect(mcp.stderr()).toContain(`devot-mcp I_MCP_NOTE_CREATED ${id} ${world.books.shared}`)
    for (const text of ['kiwi', 'Claude', 'Picked up', 'Shared']) {
      expect(mcp.stderr()).not.toContain(text)
    }
  })

  it('reports a missing database without creating one', async () => {
    const path = join(tempDir('devot-mcp-'), 'devot.sqlite')
    const mcp = await start([`--db=${path}`])
    expect((await mcp.tool('list_notebooks')).error).toMatch(/^E_STORAGE_NOT_FOUND: /)
    expect(existsSync(path)).toBe(false)
  })

  it('refuses an older schema and leaves upgrading to the app', async () => {
    const world = await makeWorld()
    setUserVersion(world.path, SCHEMA_VERSION - 1)
    const mcp = await start(['--db', world.path])
    expect((await mcp.tool('search_notes', { query: 'kiwi' })).error).toMatch(
      /^E_STORAGE_SCHEMA_TOO_OLD: .*Open Devot once/,
    )
    expect(userVersion(world.path)).toBe(SCHEMA_VERSION - 1)
  })

  it('refuses a newer schema, also when the app upgrades while it runs', async () => {
    const world = await makeWorld()
    const mcp = await start(['--db', world.path])
    expect((await mcp.tool('list_notebooks')).value).toBeDefined()
    setUserVersion(world.path, SCHEMA_VERSION + 1)
    expect((await mcp.tool('list_notebooks')).error).toMatch(/^E_STORAGE_SCHEMA_TOO_NEW: /)
    expect(
      (await mcp.tool('create_note', { title: 'T', markdown: '', notebook: 'Shared' })).error,
    ).toMatch(/^E_STORAGE_SCHEMA_TOO_NEW: /)
  })

  it('prints usage for bad arguments, on stderr', async () => {
    const child = spawn(process.execPath, [BUNDLE, '--nope'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c))
    const [code] = (await once(child, 'exit')) as [number]
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('E_MCP_USAGE')
  })
})
