import { describe, expect, it } from 'vitest'
import { writerKey, writerLabel, writerLabelParts, writersLabel } from './authorshipLabels'

describe('writerLabelParts', () => {
  it('splits the label around the name, so the kind is never the part cut short', () => {
    const writer = { kind: 'mcp', name: 'A long client name' } as const
    expect(writerLabelParts(writer)).toEqual({
      before: '',
      name: 'A long client name',
      after: ' (MCP)',
      full: writerLabel(writer),
    })
    expect(writerLabelParts(writer, 'changed by {writer}')).toEqual({
      before: 'changed by ',
      name: 'A long client name',
      after: ' (MCP)',
      full: 'changed by A long client name (MCP)',
    })
  })

  it('keeps a writer without a name as its kind alone', () => {
    expect(writerLabelParts({ kind: 'http', name: '' }, 'changed by {writer}')).toEqual({
      before: 'changed by HTTP API',
      name: '',
      after: '',
      full: 'changed by HTTP API',
    })
  })
})

describe('writerLabel', () => {
  it('names the clients Settings connects by their product names, still with the kind', () => {
    expect(writerLabel({ kind: 'mcp', name: 'claude-code' })).toBe('Claude Code (MCP)')
    expect(writerLabel({ kind: 'mcp', name: 'local-agent-mode-devot' })).toBe(
      'Claude Desktop (MCP)',
    )
    expect(writerLabel({ kind: 'mcp', name: 'claude-ai' })).toBe('Claude Desktop (MCP)')
    expect(writerLabel({ kind: 'mcp', name: 'codex-mcp-client' })).toBe('Codex (MCP)')
  })

  it("keeps an unknown client's own name", () => {
    expect(writerLabel({ kind: 'mcp', name: 'my-agent' })).toBe('my-agent (MCP)')
    expect(writerLabel({ kind: 'mcp', name: 'Claude-Code' })).toBe('Claude-Code (MCP)')
    expect(writerLabel({ kind: 'mcp', name: 'constructor' })).toBe('constructor (MCP)')
  })

  it('cuts the product name short like any other name', () => {
    expect(writerLabelParts({ kind: 'mcp', name: 'claude-code' }, 'by {writer}')).toEqual({
      before: 'by ',
      name: 'Claude Code',
      after: ' (MCP)',
      full: 'by Claude Code (MCP)',
    })
  })
})

describe('writerKey', () => {
  it('groups the names one product sends, and keeps them apart from a client that takes its label', () => {
    const desktop = writerKey({ kind: 'mcp', name: 'claude-ai' })
    expect(writerKey({ kind: 'mcp', name: 'local-agent-mode-devot' })).toBe(desktop)
    expect(writerKey({ kind: 'mcp', name: 'Claude Desktop' })).not.toBe(desktop)
    expect(writerKey({ kind: 'mcp', name: 'my-agent' })).not.toBe(
      writerKey({ kind: 'http', name: 'my-agent' }),
    )
  })

  it('lists one product once', () => {
    expect(
      writersLabel([
        { kind: 'mcp', name: 'claude-ai' },
        { kind: 'mcp', name: 'local-agent-mode-devot' },
      ]),
    ).toBe('Claude Desktop (MCP)')
  })
})
