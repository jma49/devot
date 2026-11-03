import { describe, expect, it } from 'vitest'
import {
  asMcpClientStatus,
  asMcpSetup,
  claudeCodeCommand,
  codexConfig,
  mcpServersJson,
  NO_MCP_SETUP,
  PLACEHOLDER_HELPER,
  shellWord,
} from './mcpConfigs'

const HELPER = '/Applications/My Apps/Devot.app/Contents/Helpers/devot-mcp'
const PLAIN = '/Applications/Devot.app/Contents/Helpers/devot-mcp'
const DEV_DB = '/Users/me/Library/Application Support/io.github.jma49.devot.dev/devot.sqlite'

describe('devot-mcp client configs', () => {
  it('runs the helper by itself, with the default database', () => {
    const setup = { helper: PLAIN, db: null }
    expect(claudeCodeCommand(setup)).toBe(`claude mcp add --scope user devot -- ${PLAIN}`)
    expect(codexConfig(setup)).toBe(`[mcp_servers.devot]\ncommand = "${PLAIN}"\nargs = []\n`)
    expect(JSON.parse(mcpServersJson(setup))).toEqual({
      mcpServers: { devot: { command: PLAIN, args: [] } },
    })
  })

  it('keeps a helper path with spaces whole, and passes a debug build\u2019s database', () => {
    const setup = { helper: HELPER, db: DEV_DB }
    expect(claudeCodeCommand(setup)).toBe(
      `claude mcp add --scope user devot -- '${HELPER}' --db '${DEV_DB}'`,
    )
    expect(codexConfig(setup)).toContain(`command = "${HELPER}"`)
    expect(codexConfig(setup)).toContain(`args = ["--db", "${DEV_DB}"]`)
    expect(JSON.parse(mcpServersJson(setup)).mcpServers.devot).toEqual({
      command: HELPER,
      args: ['--db', DEV_DB],
    })
  })

  it('shows the installed location when this build has no helper', () => {
    const setup = { helper: null, db: null }
    expect(claudeCodeCommand(setup)).toContain(PLACEHOLDER_HELPER)
    expect(codexConfig(setup)).toContain(PLACEHOLDER_HELPER)
    expect(mcpServersJson(setup)).toContain(PLACEHOLDER_HELPER)
  })

  it('quotes shell words and TOML strings so they read back exactly', () => {
    expect(shellWord('/a/b-c_d.mjs')).toBe('/a/b-c_d.mjs')
    expect(shellWord("/it's here")).toBe(`'/it'\\''s here'`)
    expect(shellWord('$HOME')).toBe(`'$HOME'`)
    expect(codexConfig({ helper: 'C:\\a "b"', db: null })).toContain('command = "C:\\\\a \\"b\\""')
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
  }

  it('reads a client status, refusing an unknown client or state', () => {
    expect(asMcpClientStatus(STATUS)).toEqual(STATUS)
    expect(asMcpClientStatus({ ...STATUS, client: 'other' })).toBeNull()
    expect(asMcpClientStatus({ ...STATUS, state: 'other-state' })).toBeNull()
    expect(asMcpClientStatus({ ...STATUS, path: 3 })).toBeNull()
    expect(asMcpClientStatus(null)).toBeNull()
  })

  it('reads the setup, treating anything else as unknown', () => {
    expect(asMcpSetup({ helper: HELPER, db: null, temporary: true, clients: [STATUS, 3] })).toEqual(
      { helper: HELPER, db: null, temporary: true, clients: [STATUS] },
    )
    expect(asMcpSetup({ helper: '', db: 3 })).toEqual(NO_MCP_SETUP)
    expect(asMcpSetup(null)).toBeNull()
  })
})
