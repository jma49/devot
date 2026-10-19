// The client configs Settings > Integrations offers to copy: devot-mcp run by
// Node from a Devot checkout (`node <checkout>/dist-mcp/devot-mcp.mjs`), for
// Claude Code (a `claude mcp add` command), Codex (`~/.codex/config.toml`)
// and any client that reads an `mcpServers` JSON file.
import { SERVER_NAME } from '../../../mcp/version'

export interface McpSetup {
  /** The built script in the checkout this app came from; null when it is not there. */
  script: string | null
  /** The database to pass with `--db` (a debug build's); null for the default. */
  db: string | null
}

export const PLACEHOLDER_SCRIPT = '/path/to/devot/dist-mcp/devot-mcp.mjs'

export function mcpArgs(setup: McpSetup): string[] {
  const args = [setup.script ?? PLACEHOLDER_SCRIPT]
  if (setup.db !== null) args.push('--db', setup.db)
  return args
}

/** A word as a POSIX shell reads it back exactly: quoted unless it is plainly safe. */
export function shellWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

function tomlString(text: string): string {
  let escaped = ''
  for (const c of text) {
    const code = c.charCodeAt(0)
    if (c === '\\' || c === '"') escaped += `\\${c}`
    // Control characters may not appear as they are.
    else if (code < 0x20 || code === 0x7f) escaped += `\\u${code.toString(16).padStart(4, '0')}`
    else escaped += c
  }
  return `"${escaped}"`
}

export function claudeCodeCommand(setup: McpSetup): string {
  const command = ['node', ...mcpArgs(setup)].map(shellWord).join(' ')
  return `claude mcp add --scope user ${SERVER_NAME} -- ${command}`
}

export function codexConfig(setup: McpSetup): string {
  const args = mcpArgs(setup).map(tomlString).join(', ')
  return `[mcp_servers.${SERVER_NAME}]\ncommand = "node"\nargs = [${args}]\n`
}

export function mcpServersJson(setup: McpSetup): string {
  const config = { mcpServers: { [SERVER_NAME]: { command: 'node', args: mcpArgs(setup) } } }
  return `${JSON.stringify(config, null, 2)}\n`
}

export function asMcpSetup(value: unknown): McpSetup | null {
  if (typeof value !== 'object' || value === null) return null
  const { script, db } = value as Record<string, unknown>
  const pathOrNull = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  return { script: pathOrNull(script), db: pathOrNull(db) }
}
