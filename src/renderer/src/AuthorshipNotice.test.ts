import { describe, expect, it } from 'vitest'
import type { AgentWriteSummary } from '../../core/storage'
import { noticeWriters, stepFrom } from './AuthorshipNotice'

const row = (
  writeId: string,
  kind: AgentWriteSummary['kind'],
  name: string,
): AgentWriteSummary => ({
  noteId: 'n',
  writeId,
  kind,
  name,
  at: 1,
  created: false,
  seen: false,
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

  it('steps within the changes there are', () => {
    expect(stepFrom(0, 1, 3)).toBe(1)
    expect(stepFrom(2, 1, 3)).toBe(2)
    expect(stepFrom(0, -1, 3)).toBe(0)
    expect(stepFrom(5, -1, 3)).toBe(2)
  })
})
