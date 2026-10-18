import { describe, expect, it } from 'vitest'
import {
  asMcpSetup,
  claudeCodeCommand,
  codexConfig,
  mcpServersJson,
  PLACEHOLDER_SCRIPT,
  shellWord,
} from './mcpConfigs'

const SCRIPT = '/Users/me/Code/devot/dist-mcp/devot-mcp.mjs'
const DEV_DB = '/Users/me/Library/Application Support/io.github.jma49.devot.dev/devot.sqlite'

describe('devot-mcp client configs', () => {
  it('runs the script with node, with the default database', () => {
    const setup = { script: SCRIPT, db: null }
    expect(claudeCodeCommand(setup)).toBe(`claude mcp add --scope user devot -- node ${SCRIPT}`)
    expect(codexConfig(setup)).toBe(`[mcp_servers.devot]\ncommand = "node"\nargs = ["${SCRIPT}"]\n`)
    expect(JSON.parse(mcpServersJson(setup))).toEqual({
      mcpServers: { devot: { command: 'node', args: [SCRIPT] } },
    })
  })

  it('passes a debug build\u2019s database, quoted where it has spaces', () => {
    const setup = { script: SCRIPT, db: DEV_DB }
    expect(claudeCodeCommand(setup)).toBe(
      `claude mcp add --scope user devot -- node ${SCRIPT} --db '${DEV_DB}'`,
    )
    expect(codexConfig(setup)).toContain(`args = ["${SCRIPT}", "--db", "${DEV_DB}"]`)
    expect(JSON.parse(mcpServersJson(setup)).mcpServers.devot.args).toEqual([
      SCRIPT,
      '--db',
      DEV_DB,
    ])
  })

  it('shows a placeholder path when this app does not know the script', () => {
    const setup = { script: null, db: null }
    expect(claudeCodeCommand(setup)).toContain(PLACEHOLDER_SCRIPT)
    expect(codexConfig(setup)).toContain(PLACEHOLDER_SCRIPT)
    expect(mcpServersJson(setup)).toContain(PLACEHOLDER_SCRIPT)
  })

  it('quotes shell words and TOML strings so they read back exactly', () => {
    expect(shellWord('/a/b-c_d.mjs')).toBe('/a/b-c_d.mjs')
    expect(shellWord("/it's here")).toBe(`'/it'\\''s here'`)
    expect(shellWord('$HOME')).toBe(`'$HOME'`)
    expect(codexConfig({ script: 'C:\\a "b"', db: null })).toContain('args = ["C:\\\\a \\"b\\""]')
  })

  it('reads Rust\u2019s answer, treating anything else as unknown', () => {
    expect(asMcpSetup({ script: SCRIPT, db: null })).toEqual({ script: SCRIPT, db: null })
    expect(asMcpSetup({ script: '', db: 3 })).toEqual({ script: null, db: null })
    expect(asMcpSetup(null)).toBeNull()
  })
})
