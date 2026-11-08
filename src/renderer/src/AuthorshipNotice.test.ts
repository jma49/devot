// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AgentWriteSummary } from '../../core/storage'
import { AuthorshipNotice, noticeWriters, stepFrom, undoAllLabel } from './AuthorshipNotice'
import type { EditorHandle } from './editor/handle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  it('counts the writes under every name of a product in its one Undo All', () => {
    const unseen = [row('b', 'mcp', 'local-agent-mode-devot'), row('a', 'mcp', 'claude-ai')]
    const written = [...unseen, row('c', 'mcp', 'claude-ai', true)]
    const [desktop, ...others] = noticeWriters(unseen)
    expect(others).toEqual([])
    expect(undoAllLabel(desktop!, unseen, written, true)).toBe(
      'Undo All 3 Changes by Claude Desktop (MCP)',
    )
  })

  it('steps within the changes there are', () => {
    expect(stepFrom(0, 1, 3)).toBe(1)
    expect(stepFrom(2, 1, 3)).toBe(2)
    expect(stepFrom(0, -1, 3)).toBe(0)
    expect(stepFrom(5, -1, 3)).toBe(2)
  })

  it('ends the review when the editor stops showing, as Done does', async () => {
    const unseen = [row('a', 'mcp', 'Codex')]
    const reveal = vi.fn<EditorHandle['reveal']>()
    const handle = {
      reviewSteps: () => [{ writeId: 'a', from: 0, to: 3, deleted: false }],
      reveal,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (canReview: boolean) =>
      act(async () =>
        root.render(
          createElement(AuthorshipNotice, {
            unseen,
            written: unseen,
            editor: { current: handle },
            canReview,
            editing: true,
            onUndoAll: async () => undefined,
            onDismiss: () => undefined,
          }),
        ),
      )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)
    await render(true)
    await act(async () => button('Review Changes')!.click())
    expect(button('Next Change')).toBeDefined()
    await render(false)
    expect(host.textContent).toContain('1 change by Codex (MCP) since you last looked.')
    expect(button('Next Change')).toBeUndefined()
    expect(button('Done')).toBeUndefined()
    await render(true)
    expect(button('Review Changes')).toBeDefined()
    expect(reveal).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    host.remove()
  })
})
