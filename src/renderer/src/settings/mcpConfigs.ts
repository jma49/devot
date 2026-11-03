// The client configs Settings > Integrations offers to copy, for the helper inside Devot.app:
// Claude Code (a `claude mcp add` command), Codex (`~/.codex/config.toml`) and any client that
// reads an `mcpServers` JSON file, Claude Desktop among them. Connect itself writes in Rust
// (src-tauri/src/mcp_clients.rs).
import { SERVER_NAME } from '../../../mcp/version'

export const MCP_CLIENTS = ['claudeCode', 'codex', 'claudeDesktop'] as const
export type McpClient = (typeof MCP_CLIENTS)[number]

const CONNECTION_STATES = ['notConnected', 'connected', 'stale', 'other', 'unreadable'] as const
export type McpConnectionState = (typeof CONNECTION_STATES)[number]

export interface McpClientStatus {
  client: McpClient
  /** The client's config file. */
  path: string
  /** Where the file as it was before Connect or Disconnect is kept. */
  backup: string
  state: McpConnectionState
  /** Why the file cannot be used, when the state is `unreadable`. */
  code: string | null
  /** The file is not there yet; Connect makes it. */
  missing: boolean
  /** The exact text Connect adds; null without a helper to point at. */
  preview: string | null
}

export interface McpSetup {
  /** The helper in this app; null when this build has none. */
  helper: string | null
  /** The database to pass with `--db` (a debug build's); null for the default. */
  db: string | null
  /** The app runs from a disk image or a translocated copy, so Connect waits. */
  temporary: boolean
  clients: McpClientStatus[]
}

export const NO_MCP_SETUP: McpSetup = { helper: null, db: null, temporary: false, clients: [] }

export const PLACEHOLDER_HELPER = '/Applications/Devot.app/Contents/Helpers/devot-mcp'

type ConfigSetup = Pick<McpSetup, 'helper' | 'db'>

function helperOf(setup: ConfigSetup): string {
  return setup.helper ?? PLACEHOLDER_HELPER
}

export function mcpArgs(setup: ConfigSetup): string[] {
  return setup.db === null ? [] : ['--db', setup.db]
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

export function claudeCodeCommand(setup: ConfigSetup): string {
  const command = [helperOf(setup), ...mcpArgs(setup)].map(shellWord).join(' ')
  return `claude mcp add --scope user ${SERVER_NAME} -- ${command}`
}

export function codexConfig(setup: ConfigSetup): string {
  const args = mcpArgs(setup).map(tomlString).join(', ')
  const command = tomlString(helperOf(setup))
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${command}\nargs = [${args}]\n`
}

export function mcpServersJson(setup: ConfigSetup): string {
  const config = {
    mcpServers: { [SERVER_NAME]: { command: helperOf(setup), args: mcpArgs(setup) } },
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

const textOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

export function asMcpClientStatus(value: unknown): McpClientStatus | null {
  if (typeof value !== 'object' || value === null) return null
  const { client, path, backup, state, code, missing, preview } = value as Record<string, unknown>
  if (!MCP_CLIENTS.includes(client as McpClient)) return null
  if (!CONNECTION_STATES.includes(state as McpConnectionState)) return null
  if (typeof path !== 'string' || typeof backup !== 'string') return null
  return {
    client: client as McpClient,
    path,
    backup,
    state: state as McpConnectionState,
    code: textOrNull(code),
    missing: missing === true,
    preview: textOrNull(preview),
  }
}

export function asMcpSetup(value: unknown): McpSetup | null {
  if (typeof value !== 'object' || value === null) return null
  const { helper, db, temporary, clients } = value as Record<string, unknown>
  const statuses = Array.isArray(clients) ? clients.map(asMcpClientStatus) : []
  return {
    helper: textOrNull(helper),
    db: textOrNull(db),
    temporary: temporary === true,
    clients: statuses.filter((status) => status !== null),
  }
}
