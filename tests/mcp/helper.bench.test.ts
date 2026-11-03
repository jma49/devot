// The helper Devot.app ships, built as a release builds it and driven over stdio from a folder
// with spaces, as an MCP client runs it: its own SQLite, the hardened runtime and no entitlements.
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildHelper } from '../../scripts/mcp/build-helper'
import { NO_NOTEBOOKS_HINT } from '../../src/mcp/server'
import { openSqliteAdapter, SCHEMA_VERSION } from '../../src/mcp/sqlite'
import { HIDDEN, makeWorld } from './support'
import { tempDir } from '../support/temp-dirs'

const sessions: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of sessions.splice(0)) await close()
})

describe.skipIf(process.platform !== 'darwin')('the helper in Devot.app', () => {
  let helper = ''
  beforeAll(async () => {
    helper = await buildHelper(join(tempDir('devot-helper-'), 'Devöt Apps', 'Contents Helpers'))
  }, 300_000)

  async function start(db: string, env: NodeJS.ProcessEnv = process.env) {
    const child = spawn(helper, ['--db', db], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const waiting = new Map<number, (message: { result: Record<string, unknown> }) => void>()
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as { id?: number; result: Record<string, unknown> }
      if (message.id !== undefined) waiting.get(message.id)?.(message)
    })
    let next = 1
    const request = (method: string, params: object) =>
      new Promise<{ result: Record<string, unknown> }>((done) => {
        const id = next++
        waiting.set(id, done)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    sessions.push(async () => {
      if (child.exitCode !== null) return
      child.stdin.end()
      await once(child, 'exit')
    })
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'devot-test', version: '1' },
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    const tool = async (name: string, input: object = {}) => {
      const reply = await request('tools/call', { name, arguments: input })
      const result = reply.result as { isError?: boolean; content: { text: string }[] }
      const text = result.content[0]?.text ?? ''
      return result.isError
        ? { error: text }
        : { value: JSON.parse(text) as Record<string, unknown> }
    }
    return { tool, stderr: () => stderr }
  }

  it('is signed with the hardened runtime and asks for no entitlements', () => {
    const details = execFileSync('sh', ['-c', 'codesign -dvv "$0" 2>&1', helper], {
      encoding: 'utf8',
    })
    expect(details).toMatch(/flags=0x[0-9a-f]*\([^)]*runtime/)
    const entitlements = execFileSync(
      'sh',
      ['-c', 'codesign -d --entitlements - --xml "$0" 2>/dev/null', helper],
      { encoding: 'utf8' },
    )
    expect(entitlements).toBe('')
  })

  it('searches, reads, writes and sees only allowed notebooks, with no Node installed', async () => {
    const world = await makeWorld()
    const mcp = await start(world.path, { PATH: '/usr/bin:/bin' })
    const found = await mcp.tool('search_notes', { query: 'kiwi' })
    expect((found.value?.['results'] as { id: string }[]).map((hit) => hit.id)).toEqual([
      world.ids.shared,
    ])
    for (const hidden of HIDDEN) {
      expect((await mcp.tool('read_note', { id: world.ids[hidden] })).error).toMatch(
        /^E_NOTE_NOT_FOUND: /,
      )
    }
    const made = await mcp.tool('create_note', {
      title: 'Fold Émile',
      markdown: 'Made by the helper.',
      notebook: 'Shared',
    })
    const id = made.value?.['id'] as string
    expect((await mcp.tool('read_note', { id })).value?.['markdown']).toBe('Made by the helper.')
    expect((await mcp.tool('search_notes', { query: 'ém' })).value?.['results']).toHaveLength(1)
    await mcp.tool('update_note', { id, patches: [{ find: 'Made', replace: 'Edited' }] })
    expect((await mcp.tool('read_note', { id })).value?.['markdown']).toBe('Edited by the helper.')

    const app = openSqliteAdapter(world.path, { migrate: false })
    expect((await app.getNote(id))?.title).toBe('Fold Émile')
    app.close()
    expect(mcp.stderr()).not.toMatch(/Warning|kiwi|helper\./)
  })

  it('never creates a database, and refuses a schema that is not its own', async () => {
    const missing = join(tempDir('devot-helper-missing-'), 'devot.sqlite')
    const none = await start(missing)
    expect((await none.tool('list_notebooks')).error).toMatch(/^E_STORAGE_NOT_FOUND: /)
    expect(existsSync(missing)).toBe(false)

    const world = await makeWorld()
    const db = new Database(world.path)
    db.pragma(`user_version = ${SCHEMA_VERSION - 1}`)
    db.close()
    const old = await start(world.path)
    expect((await old.tool('list_notebooks')).error).toMatch(/^E_STORAGE_SCHEMA_TOO_OLD: /)
    const check = new Database(world.path)
    expect(check.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION - 1)
    check.close()
  })

  it('says how to allow AI access on a database where nothing is allowed', async () => {
    const path = join(tempDir('devot-helper-empty-'), 'devot.sqlite')
    openSqliteAdapter(path).close()
    const mcp = await start(path)
    expect((await mcp.tool('search_notes', { query: 'kiwi' })).value).toEqual({
      results: [],
      hint: NO_NOTEBOOKS_HINT,
    })
  })

  it('takes no Node flags from the environment or the command line', () => {
    const version = execFileSync(helper, ['--version'], {
      encoding: 'utf8',
      env: { NODE_OPTIONS: '--require=/nonexistent/injected.cjs', PATH: '/usr/bin:/bin' },
    })
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(() => execFileSync(helper, ['--expose-gc'], { stdio: 'ignore' })).toThrow()
  })
})
