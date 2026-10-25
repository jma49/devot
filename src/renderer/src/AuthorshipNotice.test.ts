import { describe, expect, it } from 'vitest'
import type { AgentWriteSummary } from '../../core/storage'
import { noticeWriters, stepFrom, undoAllLabel } from './AuthorshipNotice'

const row = (
  writeId: string,
  kind: AgentWriteSummary['kind'],
  name: string,
  seen = false,
): AgentWriteSummary => ({
  noteId: 'n',
  writeId,
  kind,
  name,
  at: 1,
  created: false,
  seen,
})

describe('the review notice', () => {
  it('offers one Undo All per writer, kind and name across sessions, newest first', () => {
    const unseen = [
      row('a', 'mcp', 'Codex'),
      row('b', 'mcp', 'Claude Code'),
      row('c', 'mcp', 'Codex'),
      row('d', 'http', ''),
    ]
    expect(noticeWriters(unseen)).toEqual([
      { kind: 'mcp', name: 'Codex' },
      { kind: 'mcp', name: 'Claude Code' },
      { kind: 'http', name: '' },
    ])
  })

  it('says how many changes Undo All takes out when the writer made more than the notice counts', () => {
    const claude = { kind: 'mcp' as const, name: 'Claude Code' }
    const unseen = [row('b', 'mcp', 'Claude Code')]
    const written = [...unseen, row('a', 'mcp', 'Claude Code', true), row('c', 'mcp', 'Codex')]
    expect(undoAllLabel(claude, unseen, written, false)).toBe('Undo All 2 Changes')
    expect(undoAllLabel(claude, unseen, written, true)).toBe(
      'Undo All 2 Changes by Claude Code (MCP)',
    )
    expect(undoAllLabel(claude, unseen, unseen, false)).toBe('Undo All')
    expect(undoAllLabel(claude, unseen, unseen, true)).toBe('Undo All by Claude Code (MCP)')
  })

  it('steps within the changes there are', () => {
    expect(stepFrom(0, 1, 3)).toBe(1)
    expect(stepFrom(2, 1, 3)).toBe(2)
    expect(stepFrom(0, -1, 3)).toBe(0)
    expect(stepFrom(5, -1, 3)).toBe(2)
  })
})
