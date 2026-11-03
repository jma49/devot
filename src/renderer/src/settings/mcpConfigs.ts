// The client configs Settings > Integrations offers to copy, for the bridge in Devot's own binary
// (`devot --cli mcp`, ADR 0012):
// Claude Code (a `claude mcp add` command), Codex (`~/.codex/config.toml`) and any client that
// reads an `mcpServers` JSON file, Claude Desktop among them. Connect itself writes in Rust
// (src-tauri/src/mcp_clients.rs).
const SERVER_NAME = 'devot'

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
  /** The exact text Connect adds; null without a binary to point at. */
  preview: string | null
  /** The file as shown; Rust refuses a change once the file is no longer this. */
  revision: string
  /** Whether Devot edits the file, or runs the client's own CLI (`claude mcp`). */
  via: 'file' | 'claudeCli'
}

export interface McpSetup {
  /** This app's binary; null when Rust cannot say. */
  command: string | null
  /** What makes it the bridge. */
  args: string[]
  /** The app runs from a disk image or a translocated copy, so Connect waits. */
  temporary: boolean
  clients: McpClientStatus[]
}

export const BRIDGE_ARGS = ['--cli', 'mcp']
export const NO_MCP_SETUP: McpSetup = {
  command: null,
  args: BRIDGE_ARGS,
  temporary: false,
  clients: [],
}

export const PLACEHOLDER_COMMAND = '/Applications/Devot.app/Contents/MacOS/devot'

type ConfigSetup = Pick<McpSetup, 'command' | 'args'>

function commandOf(setup: ConfigSetup): string {
  return setup.command ?? PLACEHOLDER_COMMAND
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
  const command = [commandOf(setup), ...setup.args].map(shellWord).join(' ')
  return `claude mcp add --scope user ${SERVER_NAME} -- ${command}`
}

export function codexConfig(setup: ConfigSetup): string {
  const args = setup.args.map(tomlString).join(', ')
  const command = tomlString(commandOf(setup))
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${command}\nargs = [${args}]\n`
}

export function mcpServersJson(setup: ConfigSetup): string {
  const config = {
    mcpServers: { [SERVER_NAME]: { command: commandOf(setup), args: setup.args } },
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

const textOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

export function asMcpClientStatus(value: unknown): McpClientStatus | null {
  if (typeof value !== 'object' || value === null) return null
  const { client, path, backup, state, code, missing, preview, revision, via } = value as Record<
    string,
    unknown
  >
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
    revision: typeof revision === 'string' ? revision : '',
    via: via === 'claudeCli' ? 'claudeCli' : 'file',
  }
}

export function asMcpSetup(value: unknown): McpSetup | null {
  if (typeof value !== 'object' || value === null) return null
  const { command, args, temporary, clients } = value as Record<string, unknown>
  const statuses = Array.isArray(clients) ? clients.map(asMcpClientStatus) : []
  return {
    command: textOrNull(command),
    args:
      Array.isArray(args) && args.every((arg) => typeof arg === 'string')
        ? (args as string[])
        : BRIDGE_ARGS,
    temporary: temporary === true,
    clients: statuses.filter((status) => status !== null),
  }
}

const SCOPES = ['read', 'readWrite'] as const
export type McpScope = (typeof SCOPES)[number]

export interface McpAccess {
  enabled: boolean
  scope: McpScope
  backgroundStart: boolean
  /** A connected client can get through now. */
  reachable: boolean
  /** Why it is on but not reachable. */
  problem: string | null
}

export function asMcpAccess(value: unknown): McpAccess | null {
  if (typeof value !== 'object' || value === null) return null
  const { enabled, scope, backgroundStart, reachable, problem } = value as Record<string, unknown>
  if (typeof enabled !== 'boolean' || typeof backgroundStart !== 'boolean') return null
  if (!SCOPES.includes(scope as McpScope)) return null
  return {
    enabled,
    scope: scope as McpScope,
    backgroundStart,
    reachable: reachable === true,
    problem: textOrNull(problem),
  }
}

export type RunMode = 'background' | 'normal'

export function asRunMode(value: unknown): RunMode | null {
  if (typeof value !== 'object' || value === null) return null
  const { mode } = value as Record<string, unknown>
  return mode === 'background' || mode === 'normal' ? mode : null
}
