// The MCP bridge's tool list (src-tauri/mcp/tools.json, which Rust compiles in) against the core's
// limits, so its rules stay the core's alone, and the plugin layout for later against the launcher.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AI_SEARCH_LIMIT,
  MAX_AI_BODY_BYTES,
  MAX_AI_PATCHES,
  MAX_AI_SEARCH_LIMIT,
  MAX_AI_TAGS,
} from '../../src/core/ai'
import { APPEND_POSITIONS, APPEND_SEPARATORS, MAX_HEADING_CHARS } from '../../src/core/append'
import { MAX_WRITER_NAME_CHARS } from '../../src/core/authorship'
import { MAX_BOOK_NAME_CHARS } from '../../src/core/books'
import { MAX_NOTE_LINKS } from '../../src/core/links'
import { MAX_BODY_BYTES, MAX_TITLE_CHARS } from '../../src/core/noteLimits'
import { NOTE_STATUSES } from '../../src/core/storage'
import { MAX_TAG_NAME_CHARS } from '../../src/core/tags'

interface Tool {
  name: string
  title: string
  description: string
  inputSchema: {
    type: string
    required?: string[]
    properties: Record<string, Record<string, unknown> & { items?: Record<string, unknown> }>
  }
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean }
}

const read = (path: string) => readFileSync(path, 'utf8')
const tools = JSON.parse(read('src-tauri/mcp/tools.json')) as Tool[]
const tool = (name: string) => tools.find((found) => found.name === name)!
const tryTools = read('src-tauri/src/mcp_bridge/tools.rs')
const rustConst = (source: string, name: string) => {
  const found = new RegExp(`const ${name}: usize = ([\\d_ *]+);`).exec(source)
  if (!found) throw new Error(`no ${name}`)
  return found[1]!.split('*').reduce((n, part) => n * Number(part.trim().replace(/_/g, '')), 1)
}

describe('the tool list', () => {
  it('has the nine tools, each with its title and annotations', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'list_notebooks',
      'search_notes',
      'read_note',
      'list_tags',
      'create_note',
      'update_note',
      'append_to_note',
      'trash_note',
      'create_notebook',
    ])
    for (const t of tools) {
      expect(t.title).not.toBe('')
      expect(t.description).toMatch(/AI access|Devot/)
      expect(t.annotations.openWorldHint).toBe(false)
    }
    const reads = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)
    expect(reads).toEqual(['list_notebooks', 'search_notes', 'read_note', 'list_tags'])
    const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)
    expect(destructive).toEqual(['trash_note'])
  })

  it('holds arguments to the limits of the core', () => {
    const search = tool('search_notes').inputSchema.properties
    expect(search['limit']!['maximum']).toBe(MAX_AI_SEARCH_LIMIT)
    expect(search['limit']!['description']).toContain(String(AI_SEARCH_LIMIT))
    const update = tool('update_note').inputSchema.properties
    expect(update['title']!['maxLength']).toBe(MAX_TITLE_CHARS * 4)
    expect(update['patches']!['maxItems']).toBe(MAX_AI_PATCHES)
    expect(update['tags']!['maxItems']).toBe(MAX_AI_TAGS)
    expect(update['tags']!.items!['maxLength']).toBe(MAX_TAG_NAME_CHARS * 4)
    expect(update['status']!['enum']).toEqual([...NOTE_STATUSES])
    expect(tool('create_notebook').inputSchema.properties['name']!['maxLength']).toBe(
      MAX_BOOK_NAME_CHARS * 4,
    )
    const append = tool('append_to_note')
    expect(append.inputSchema.required).toEqual(['id', 'text'])
    expect(append.inputSchema.properties['heading']!['maxLength']).toBe(MAX_HEADING_CHARS)
    expect(append.inputSchema.properties['position']!['enum']).toEqual([...APPEND_POSITIONS])
    expect(append.inputSchema.properties['separator']!['enum']).toEqual([...APPEND_SEPARATORS])
  })

  it('tells clients the limits the core holds them to', () => {
    expect(rustConst(tryTools, 'MAX_BOOK_NAME_CHARS')).toBe(MAX_BOOK_NAME_CHARS)
    expect(rustConst(tryTools, 'MAX_TAG_NAME_CHARS')).toBe(MAX_TAG_NAME_CHARS)
    expect(rustConst(tryTools, 'MAX_NOTE_LINKS')).toBe(MAX_NOTE_LINKS)
    expect(rustConst(tryTools, 'MAX_PATCHES')).toBe(MAX_AI_PATCHES)
    expect(rustConst(tryTools, 'MAX_TAGS')).toBe(MAX_AI_TAGS)
    const routes = read('src-tauri/src/http_api/routes.rs')
    expect(rustConst(routes, 'MAX_MARKDOWN_BYTES')).toBe(MAX_AI_BODY_BYTES)
    expect(rustConst(routes, 'MAX_HEADING_CHARS')).toBe(MAX_HEADING_CHARS)
    expect(rustConst(routes, 'MAX_CLIENT_NAME_CHARS')).toBe(MAX_WRITER_NAME_CHARS)
    const notes = read('src-tauri/src/commands/notes.rs')
    expect(rustConst(notes, 'MAX_BODY_BYTES')).toBe(MAX_BODY_BYTES)
    expect(tryTools).toContain(NOTE_STATUSES.join(', '))
  })
})

describe('the directory plugin layout for later', () => {
  const root = 'docs/mcp-plugin'

  it('uses only the launcher, the same one the extension carries, outside bin/', () => {
    expect(read(`${root}/scripts/devot-mcp.sh`)).toBe(read('src-tauri/mcp/devot-mcp.sh'))
    expect(readdirSync(`${root}/scripts`)).toEqual(['devot-mcp.sh'])
    expect(readdirSync(root)).not.toContain('bin')
    const config = JSON.parse(read(`${root}/.mcp.json`)) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(config.mcpServers).toEqual({
      devot: { command: '/bin/sh', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/devot-mcp.sh'] },
    })
  })

  it('is a marketplace that lists itself as the plugin, with the app icon', () => {
    const manifest = JSON.parse(read(`${root}/.claude-plugin/plugin.json`)) as { name: string }
    expect(manifest.name).toBe('devot')
    const marketplace = JSON.parse(read(`${root}/.claude-plugin/marketplace.json`)) as {
      plugins: { name: string; source: string }[]
    }
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'devot', source: './' })])
    expect(readFileSync(`${root}/.claude-plugin/icon.png`)).toEqual(
      readFileSync('src-tauri/icons/icon.png'),
    )
  })
})
