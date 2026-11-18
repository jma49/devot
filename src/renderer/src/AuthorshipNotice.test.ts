// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AgentWriteSummary } from '../../core/storage'
import {
  AuthorshipNotice,
  keyedSteps,
  noticeWriters,
  stepFrom,
  undoAllLabel,
} from './AuthorshipNotice'
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
      undoGroup: (id: string) => [id],
      reviewSteps: () => [
        { writeId: 'a', from: 0, to: 3, deleted: false, anchor: 'a-0', end: 'a-0' },
      ],
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

  it('supports per-step Keep and Undo, renders deleted text preview, and restores Preview mode on Done', async () => {
    const unseen = [row('w1', 'mcp', 'Codex'), row('w2', 'mcp', 'Claude Code')]
    const stepsBySet = {
      current: [
        { writeId: 'w1', from: 0, to: 3, deleted: false, anchor: 'w1-0', end: 'w1-0' },
        {
          writeId: 'w2',
          from: 10,
          to: 10,
          deleted: true,
          anchor: 'w2-10',
          end: 'w2-10',
          removed: 'removed phrase',
        },
      ],
    }
    const reveal = vi.fn<EditorHandle['reveal']>()
    const onKeepWrite = vi.fn<(id: string) => Promise<boolean>>(async (id) => {
      stepsBySet.current = stepsBySet.current.filter((s) => s.writeId !== id)
      return true
    })
    const onUndoWrite = vi.fn<(id: string) => Promise<boolean>>(async (id) => {
      stepsBySet.current = stepsBySet.current.filter((s) => s.writeId !== id)
      return true
    })
    const onStartReview = vi.fn<() => void>()
    const onEndReview = vi.fn<() => void>()
    const handle = {
      undoGroup: (id: string) => [id],
      reviewSteps: (only: ReadonlySet<string>) =>
        stepsBySet.current.filter((s) => only.has(s.writeId)),
      reveal,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (canReview: boolean, rows = unseen) =>
      act(async () =>
        root.render(
          createElement(AuthorshipNotice, {
            unseen: rows,
            written: rows,
            editor: { current: handle },
            canReview,
            editing: true,
            onStartReview,
            onEndReview,
            onKeepWrite,
            onUndoWrite,
            onUndoAll: async () => undefined,
            onDismiss: () => undefined,
          }),
        ),
      )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)

    await render(false)
    expect(button('Review Changes')).toBeDefined()
    await act(async () => button('Review Changes')!.click())
    expect(onStartReview).toHaveBeenCalledTimes(1)
    await render(true)
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    expect(reveal).toHaveBeenLastCalledWith(0, 3)

    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).toHaveBeenCalledWith('w1')
    expect(reveal).toHaveBeenLastCalledWith(10, 10)
    expect(host.querySelector('[data-devot-part="authorship-removed"]')?.textContent).toBe(
      'removed phrase',
    )

    await act(async () => button('Undo')!.click())
    expect(onUndoWrite).toHaveBeenCalledWith('w2')
    expect(onEndReview).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    host.remove()
  })

  it('drops late Keep answers if unmounted before the write finishes', async () => {
    const unseen = [row('w1', 'mcp', 'Codex'), row('w2', 'mcp', 'Claude Code')]
    let finishKeep!: () => void
    const onKeepWrite = vi.fn<() => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          finishKeep = () => resolve(true)
        }),
    )
    const reveal = vi.fn<EditorHandle['reveal']>()
    const onEndReview = vi.fn<() => void>()
    const handle = {
      undoGroup: (id: string) => [id],
      reviewSteps: () => [
        { writeId: 'w1', from: 0, to: 3, deleted: false, anchor: 'w1-0', end: 'w1-0' },
        { writeId: 'w2', from: 5, to: 8, deleted: false, anchor: 'w2-5', end: 'w2-5' },
      ],
      reveal,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(AuthorshipNotice, {
          unseen,
          written: unseen,
          editor: { current: handle },
          canReview: true,
          editing: true,
          onEndReview,
          onKeepWrite,
          onUndoWrite: async () => true,
          onUndoAll: async () => undefined,
          onDismiss: () => undefined,
        }),
      ),
    )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)
    await act(async () => button('Review Changes')!.click())
    await act(async () => {
      button('Keep')!.click()
    })
    expect(button('Done')!.disabled).toBe(true)
    const callsBeforeFinish = reveal.mock.calls.length
    await act(async () => root.unmount())
    await act(async () => {
      finishKeep()
      await Promise.resolve()
    })
    expect(reveal).toHaveBeenCalledTimes(callsBeforeFinish)
    expect(onEndReview).not.toHaveBeenCalled()
    host.remove()
  })

  it('keys steps by their write and first and last items, so a kept step stays kept when another step’s text goes', () => {
    const steps = [
      { writeId: 'w1', from: 0, to: 2, deleted: false, anchor: '2:0', end: '2:0' },
      { writeId: 'w2', from: 4, to: 6, deleted: false, anchor: '3:0', end: '3:0' },
      { writeId: 'w1', from: 8, to: 9, deleted: false, anchor: '2:5', end: '2:5' },
      { writeId: 'w1', from: 11, to: 12, deleted: false, anchor: '2:9', end: '2:9' },
    ]
    expect(keyedSteps(steps, new Set(), new Set()).map((s) => s.key)).toEqual([
      'w1@2:0..2:0',
      'w2@3:0..3:0',
      'w1@2:5..2:5',
      'w1@2:9..2:9',
    ])
    const kept = new Set(['w1@2:5..2:5'])
    expect(keyedSteps(steps, kept, new Set()).map((s) => s.key)).toEqual([
      'w1@2:0..2:0',
      'w2@3:0..3:0',
      'w1@2:9..2:9',
    ])
    // The owner deletes the text of w1's first step: the step after the kept one still shows.
    expect(keyedSteps(steps.slice(1), kept, new Set()).map((s) => s.key)).toEqual([
      'w2@3:0..3:0',
      'w1@2:9..2:9',
    ])
    expect(keyedSteps(steps, new Set(), new Set(['w1'])).map((s) => s.key)).toEqual(['w2@3:0..3:0'])
  })

  it('shows a kept step again once undoing the change between it and the next made them one', async () => {
    const unseen = [row('w1', 'mcp', 'Codex'), row('w2', 'mcp', 'Claude Code')]
    let steps = [
      { writeId: 'w1', from: 0, to: 3, deleted: false, anchor: '2:0', end: '2:2' },
      { writeId: 'w2', from: 3, to: 5, deleted: false, anchor: '3:0', end: '3:1' },
      { writeId: 'w1', from: 5, to: 8, deleted: false, anchor: '2:3', end: '2:5' },
    ]
    const reveal = vi.fn<EditorHandle['reveal']>()
    const onKeepWrite = vi.fn<(id: string) => Promise<boolean>>(async () => true)
    const onEndReview = vi.fn<() => void>()
    const handle = {
      undoGroup: (id: string) => [id],
      reviewSteps: (only: ReadonlySet<string>) => steps.filter((s) => only.has(s.writeId)),
      reveal,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(AuthorshipNotice, {
          unseen,
          written: unseen,
          editor: { current: handle },
          canReview: true,
          editing: true,
          onEndReview,
          onKeepWrite,
          onUndoWrite: async () => {
            steps = [{ writeId: 'w1', from: 0, to: 6, deleted: false, anchor: '2:0', end: '2:5' }]
            return true
          },
          onUndoAll: async () => undefined,
          onDismiss: () => undefined,
        }),
      ),
    )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)
    await act(async () => button('Review Changes')!.click())
    await act(async () => button('Keep')!.click())
    expect(reveal).toHaveBeenLastCalledWith(3, 5)
    await act(async () => button('Undo')!.click())
    expect(onEndReview).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenLastCalledWith(0, 6)
    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).toHaveBeenCalledExactlyOnceWith('w1')
    expect(onEndReview).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps the step in the review when marking it kept fails, so Keep can be pressed again', async () => {
    const unseen = [row('w1', 'mcp', 'Codex')]
    const steps = [{ writeId: 'w1', from: 0, to: 3, deleted: false, anchor: '2:0', end: '2:2' }]
    let saves = false
    const onKeepWrite = vi.fn<(id: string) => Promise<boolean>>(async () => saves)
    const onEndReview = vi.fn<() => void>()
    const handle = {
      undoGroup: (id: string) => [id],
      reviewSteps: (only: ReadonlySet<string>) => steps.filter((s) => only.has(s.writeId)),
      reveal: () => undefined,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(AuthorshipNotice, {
          unseen,
          written: unseen,
          editor: { current: handle },
          canReview: true,
          editing: true,
          onEndReview,
          onKeepWrite,
          onUndoWrite: async () => true,
          onUndoAll: async () => undefined,
          onDismiss: () => undefined,
        }),
      ),
    )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)
    await act(async () => button('Review Changes')!.click())
    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).toHaveBeenCalledTimes(1)
    expect(onEndReview).not.toHaveBeenCalled()
    expect(button('Keep')).toBeDefined()
    saves = true
    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).toHaveBeenCalledTimes(2)
    expect(onEndReview).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    host.remove()
  })

  it('says when Undo takes back a whole edit of several places, or later edits with it', async () => {
    const unseen = [row('w1', 'mcp', 'Codex'), row('w2', 'mcp', 'Codex')]
    let steps = [
      { writeId: 'w1', from: 0, to: 2, deleted: false, anchor: '2:0', end: '2:0' },
      { writeId: 'w1', from: 5, to: 7, deleted: false, anchor: '2:4', end: '2:4' },
      { writeId: 'w2', from: 9, to: 9, deleted: true, anchor: '3:0', end: '3:0' },
    ]
    const groups: Record<string, string[]> = { w1: ['w1'], w2: ['w2'] }
    const onUndoWrite = vi.fn<(id: string) => Promise<boolean>>(async (id) => {
      steps = steps.filter((step) => !groups[id]!.includes(step.writeId))
      return true
    })
    const onEndReview = vi.fn<() => void>()
    const handle = {
      undoGroup: (id: string) => groups[id]!,
      reviewSteps: (only: ReadonlySet<string>) => steps.filter((s) => only.has(s.writeId)),
      reveal: () => undefined,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(AuthorshipNotice, {
          unseen,
          written: unseen,
          editor: { current: handle },
          canReview: true,
          editing: true,
          onEndReview,
          onKeepWrite: async () => true,
          onUndoWrite,
          onUndoAll: async () => undefined,
          onDismiss: () => undefined,
        }),
      ),
    )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)
    const undoButton = () => host.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="U"]')
    await act(async () => button('Review Changes')!.click())
    expect(undoButton()?.textContent).toBe('Undo Whole Edit (2 Places)')
    await act(async () => button('Keep')!.click())
    expect(undoButton()?.textContent).toBe('Undo Whole Edit (2 Places)')
    await act(async () => button('Next Change')!.click())
    expect(undoButton()?.textContent).toBe('Undo')

    groups['w1'] = ['w2', 'w1']
    await act(async () => button('Previous Change')!.click())
    expect(undoButton()?.textContent).toBe('Undo 2 Edits')
    await act(async () => undoButton()!.click())
    expect(onUndoWrite).toHaveBeenCalledExactlyOnceWith('w1')
    expect(onEndReview).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    host.remove()
  })

  it('marks a write seen only when Keep reaches its last step, then ends after the last change', async () => {
    const unseen = [row('w1', 'mcp', 'Codex')]
    const steps = [
      { writeId: 'w1', from: 0, to: 2, deleted: false, anchor: 'w1-0', end: 'w1-0' },
      { writeId: 'w1', from: 5, to: 7, deleted: false, anchor: 'w1-5', end: 'w1-5' },
      {
        writeId: 'w1',
        from: 9,
        to: 9,
        deleted: true,
        anchor: 'w1-9',
        end: 'w1-9',
        removed: 'gone',
      },
    ]
    const reveal = vi.fn<EditorHandle['reveal']>()
    const onKeepWrite = vi.fn<(id: string) => Promise<boolean>>(async () => true)
    const onEndReview = vi.fn<() => void>()
    const handle = {
      undoGroup: (id: string) => [id],
      reviewSteps: () => steps,
      reveal,
      focus: () => undefined,
    } as unknown as EditorHandle
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(AuthorshipNotice, {
          unseen,
          written: unseen,
          editor: { current: handle },
          canReview: true,
          editing: true,
          onEndReview,
          onKeepWrite,
          onUndoAll: async () => undefined,
          onDismiss: () => undefined,
        }),
      ),
    )
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === name)
    const status = () => host.querySelector('[role="status"]')?.textContent
    await act(async () => button('Review Changes')!.click())
    expect(status()).toContain('1 of 3')
    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenLastCalledWith(5, 7)
    expect(status()).toContain('1 of 2')
    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenLastCalledWith(9, 9)
    expect(host.querySelector('[data-devot-part="authorship-removed"]')?.textContent).toBe('gone')
    await act(async () => button('Keep')!.click())
    expect(onKeepWrite).toHaveBeenCalledExactlyOnceWith('w1')
    expect(onEndReview).toHaveBeenCalledTimes(1)
    expect(button('Review Changes')).toBeDefined()

    await act(async () => root.unmount())
    host.remove()
  })
})
