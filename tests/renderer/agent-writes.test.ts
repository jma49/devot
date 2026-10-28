// The window's view of this device's agent writes, narrowed to a workspace's notes (A055), and the
// mark-seen a quit waits for (A067).
import { describe, expect, it, vi } from 'vitest'
import type { AgentWriteSummary } from '../../src/core/storage'
import { agentWritesView, inNotes, markSeen, unseenOf } from '../../src/renderer/src/agentWrites'

let next = 0
const row = (
  noteId: string,
  name: string,
  seen: boolean,
  kind: AgentWriteSummary['kind'] = 'mcp',
): AgentWriteSummary => ({
  noteId,
  writeId: `W${++next}`,
  kind,
  name,
  at: next,
  created: false,
  seen,
})

describe('inNotes', () => {
  const rows = [
    row('a', 'claude', false),
    row('a', 'claude', true),
    row('b', 'claude', false),
    row('c', 'codex', false),
  ]
  const view = agentWritesView(rows, ['a', 'b', 'c'])

  it('keeps only the notes of the set, with their own counts', () => {
    const inA = inNotes(view, new Set(['a']))
    expect([...inA.byNote.keys()]).toEqual(['a'])
    expect(unseenOf(inA, 'a')).toHaveLength(1)
    expect(inA.agents).toHaveLength(1)
    expect(inA.agents[0]?.unseen).toBe(1)
    expect([...(inA.agents[0]?.noteIds ?? [])]).toEqual(['a'])
    expect([...inA.authored]).toEqual(['a'])
    expect(inA.changedBy.get('a')).toEqual({ kind: 'mcp', name: 'claude' })
  })

  it('drops an agent with none of its notes in the set', () => {
    const inB = inNotes(view, new Set(['b']))
    expect(inB.agents.map((a) => a.name)).toEqual(['claude'])
    expect(inB.changedBy.has('c')).toBe(false)
  })

  it('keeps Edit with AI out of the agents, as the whole view does', () => {
    const aiEdit = agentWritesView([row('d', '', false, 'aiEdit')], ['d'])
    const narrowed = inNotes(aiEdit, new Set(['d']))
    expect(narrowed.agents).toEqual([])
    expect(narrowed.changedBy.get('d')).toEqual({ kind: 'aiEdit', name: '' })
  })
})

/** The core's `markWritesSeen`, which a remote core wraps; only the promise matters here. */
const coreWith = (markWritesSeen: (noteId: string, ids: readonly string[]) => Promise<void>) =>
  ({ markWritesSeen }) as unknown as Parameters<typeof markSeen>[0]

describe('markSeen', () => {
  const shown = { noteId: 'a', ids: new Set(['W1', 'W2']) }

  it('marks the shown rows and reloads, once it is done', async () => {
    const markWritesSeen = vi.fn<(noteId: string, ids: readonly string[]) => Promise<void>>(() =>
      Promise.resolve(),
    )
    const reload = vi.fn<() => void>()
    await markSeen(coreWith(markWritesSeen), reload, shown)
    expect(markWritesSeen).toHaveBeenCalledWith('a', ['W1', 'W2'])
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not reload when the app is leaving', async () => {
    const markWritesSeen = vi.fn<(noteId: string, ids: readonly string[]) => Promise<void>>(() =>
      Promise.resolve(),
    )
    const reload = vi.fn<() => void>()
    await markSeen(coreWith(markWritesSeen), reload, shown, { reload: false })
    expect(markWritesSeen).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })

  it('does nothing, and still resolves, with no rows shown', async () => {
    const markWritesSeen = vi.fn<(noteId: string, ids: readonly string[]) => Promise<void>>(() =>
      Promise.resolve(),
    )
    const reload = vi.fn<() => void>()
    await markSeen(coreWith(markWritesSeen), reload, undefined)
    await markSeen(coreWith(markWritesSeen), reload, { noteId: 'a', ids: new Set() })
    expect(markWritesSeen).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('resolves when marking fails, so a quit is never held by it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const markWritesSeen = vi.fn<(noteId: string, ids: readonly string[]) => Promise<void>>(() =>
      Promise.reject(new Error('E_TEST')),
    )
    const reload = vi.fn<() => void>()
    await expect(markSeen(coreWith(markWritesSeen), reload, shown)).resolves.toBeUndefined()
    expect(reload).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('W_AGENT_WRITES_SEEN_FAILED', 'a', 'E_TEST')
    warn.mockRestore()
  })
})
