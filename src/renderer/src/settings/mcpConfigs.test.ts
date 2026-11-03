import { describe, expect, it } from 'vitest'
import {
  asMcpAccess,
  asMcpClientStatus,
  asMcpSetup,
  asRunMode,
  BRIDGE_ARGS,
  claudeCodeCommand,
  codexConfig,
  mcpServersJson,
  NO_MCP_SETUP,
  PLACEHOLDER_COMMAND,
  shellWord,
} from './mcpConfigs'

const SPACED = '/Applications/My Apps/Devot.app/Contents/MacOS/devot'
const PLAIN = '/Applications/Devot.app/Contents/MacOS/devot'
const args = ['--cli', 'mcp']

describe('MCP client configs', () => {
  it('runs this app as the bridge, with no runtime and no token', () => {
    const setup = { command: PLAIN, args }
    expect(claudeCodeCommand(setup)).toBe(`claude mcp add --scope user devot -- ${PLAIN} --cli mcp`)
    expect(codexConfig(setup)).toBe(
      `[mcp_servers.devot]\ncommand = "${PLAIN}"\nargs = ["--cli", "mcp"]\n`,
    )
    expect(JSON.parse(mcpServersJson(setup))).toEqual({
      mcpServers: { devot: { command: PLAIN, args } },
    })
    for (const text of [claudeCodeCommand(setup), codexConfig(setup), mcpServersJson(setup)]) {
      expect(text).not.toMatch(/node|dvt_|token/i)
    }
  })

  it('keeps a path with spaces whole', () => {
    const setup = { command: SPACED, args }
    expect(claudeCodeCommand(setup)).toBe(
      `claude mcp add --scope user devot -- '${SPACED}' --cli mcp`,
    )
    expect(codexConfig(setup)).toContain(`command = "${SPACED}"`)
    expect(JSON.parse(mcpServersJson(setup)).mcpServers.devot.command).toBe(SPACED)
  })

  it('shows the installed location when Rust cannot say', () => {
    const setup = { command: null, args }
    expect(claudeCodeCommand(setup)).toContain(PLACEHOLDER_COMMAND)
    expect(codexConfig(setup)).toContain(PLACEHOLDER_COMMAND)
    expect(mcpServersJson(setup)).toContain(PLACEHOLDER_COMMAND)
  })

  it('quotes shell words and TOML strings so they read back exactly', () => {
    expect(shellWord('/a/b-c_d')).toBe('/a/b-c_d')
    expect(shellWord("/it's here")).toBe(`'/it'\\''s here'`)
    expect(shellWord('$HOME')).toBe(`'$HOME'`)
    expect(codexConfig({ command: 'C:\\a "b"', args: [] })).toContain('command = "C:\\\\a \\"b\\""')
  })
})

describe('Rust\u2019s answer', () => {
  const STATUS = {
    client: 'codex',
    path: '/Users/me/.codex/config.toml',
    backup: '/Users/me/.codex/config.toml.devot-backup',
    state: 'stale',
    code: null,
    missing: false,
    preview: '[mcp_servers.devot]\n',
    revision: 'missing',
    via: 'file',
  }

  it('reads a client status, refusing an unknown client or state', () => {
    expect(asMcpClientStatus(STATUS)).toEqual(STATUS)
    expect(asMcpClientStatus({ ...STATUS, client: 'other' })).toBeNull()
    expect(asMcpClientStatus({ ...STATUS, state: 'other-state' })).toBeNull()
    expect(asMcpClientStatus({ ...STATUS, path: 3 })).toBeNull()
    expect(asMcpClientStatus({ ...STATUS, via: 'claudeCli' })?.via).toBe('claudeCli')
    expect(asMcpClientStatus({ ...STATUS, via: 'shell' })?.via).toBe('file')
    expect(asMcpClientStatus(null)).toBeNull()
  })

  it('reads the setup, treating anything else as unknown', () => {
    expect(asMcpSetup({ command: SPACED, args, temporary: true, clients: [STATUS, 3] })).toEqual({
      command: SPACED,
      args,
      temporary: true,
      clients: [STATUS],
    })
    expect(asMcpSetup({ command: '', args: 3 })).toEqual(NO_MCP_SETUP)
    expect(asMcpSetup(null)).toBeNull()
    expect(NO_MCP_SETUP.args).toEqual(BRIDGE_ARGS)
  })

  it('reads MCP access, refusing an unknown scope', () => {
    const access = {
      enabled: true,
      scope: 'read',
      backgroundStart: false,
      reachable: true,
      problem: null,
    }
    expect(asMcpAccess(access)).toEqual(access)
    expect(asMcpAccess({ ...access, scope: 'admin' })).toBeNull()
    expect(asMcpAccess({ ...access, enabled: 'yes' })).toBeNull()
    expect(asMcpAccess(null)).toBeNull()
  })

  it('reads how Devot runs now', () => {
    expect(asRunMode({ mode: 'background' })).toBe('background')
    expect(asRunMode({ mode: 'normal' })).toBe('normal')
    expect(asRunMode({ mode: 'other' })).toBeNull()
    expect(asRunMode(null)).toBeNull()
  })
})
