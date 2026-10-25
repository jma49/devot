import { describe, expect, it } from 'vitest'
import type { AgentWriteSummary } from '../../core/storage'
import { agentWritesView, MAX_AGENTS_LISTED, unseenOf } from './agentWrites'

const row = (
  noteId: string,
  at: number,
  kind: AgentWriteSummary['kind'],
  name: string,
  seen = false,
): AgentWriteSummary => ({ noteId, writeId: `w${at}`, kind, name, at, created: false, seen })

describe('agentWritesView', () => {
  // As listAgentWrites gives them: newest first.
  const rows = [
    row('a', 50, 'aiEdit', '', true),
    row('b', 40, 'http', ''),
    row('a', 30, 'mcp', 'Claude Code'),
    row('a', 20, 'mcp', 'Codex', true),
    row('c', 10, 'mcp', 'Claude Code'),
  ]

  it('names the newest unseen writer of each note for the list', () => {
    const { changedBy } = agentWritesView(rows)
    expect([...changedBy]).toEqual([
      ['b', 'HTTP API'],
      ['a', 'Claude Code (MCP)'],
      ['c', 'Claude Code (MCP)'],
    ])
  })

  it('lists the agents newest first with their unseen counts, leaving Edit with AI out', () => {
    const { agents } = agentWritesView(rows)
    expect(agents.map((a) => [a.key, a.unseen, [...a.noteIds]])).toEqual([
      ['http:', 1, ['b']],
      ['mcp:Claude Code', 2, ['a', 'c']],
      ['mcp:Codex', 0, ['a']],
    ])
  })

  it('keeps each note’s rows, and the open note’s unseen ones', () => {
    const view = agentWritesView(rows)
    expect(view.byNote.get('a')?.map((r) => r.at)).toEqual([50, 30, 20])
    expect(unseenOf(view, 'a').map((r) => r.at)).toEqual([30])
    expect(unseenOf(view, undefined)).toEqual([])
  })

  it('lists a bounded number of agents', () => {
    const many = Array.from({ length: MAX_AGENTS_LISTED + 3 }, (_, i) =>
      row('n', 100 - i, 'mcp', `Client ${i}`),
    )
    expect(agentWritesView(many).agents).toHaveLength(MAX_AGENTS_LISTED)
  })
})
