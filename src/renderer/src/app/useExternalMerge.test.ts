// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MergedStored, OpenedNote } from '../../../core'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { dbChanged } from '../externalChanges'
import { useExternalMerge } from './useExternalMerge'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))

afterEach(unmountAll)

const VECTOR = new Uint8Array([1])
const STATE = new Uint8Array([2])

function merging(merged: () => Promise<MergedStored>) {
  const core = {
    mergeStored: vi.fn<() => Promise<MergedStored>>(merged),
    open: vi.fn<(id: string, known?: Uint8Array) => Promise<OpenedNote>>(async (id) => ({
      id,
      title: 'Plan',
      state: STATE,
    })),
    flush: vi.fn<() => Promise<void>>(async () => {}),
    mirrorTouch: vi.fn<() => Promise<void>>(async () => {}),
  }
  const editor = {
    noteId: 'n1',
    vector: () => VECTOR,
    takeState: vi.fn<(state: Uint8Array) => void>(),
  }
  const props = {
    core: core as unknown as Core,
    selected: 'n1',
    inTrash: false,
    opens: { current: 0 },
    editorRef: { current: editor as unknown as EditorHandle },
    setTitle: vi.fn<(title: string) => void>(),
    refresh: vi.fn<(c: Core) => Promise<void>>(async () => {}),
    patch: vi.fn<(c: Core, ids: readonly string[]) => Promise<void>>(async () => {}),
    agentWrites: { reload: vi.fn<() => void>() },
  }
  renderHook(useExternalMerge, { props })
  return { ...props, core, editor }
}

const unchanged =
  (...ids: string[]) =>
  async () => ({ retitled: [], unchanged: ids })

describe('useExternalMerge', () => {
  it("leaves the open note's editor alone when the write did not change the note", async () => {
    const m = merging(unchanged('n1'))
    window.dispatchEvent(dbChanged())
    await settle()
    expect(m.core.mergeStored).toHaveBeenCalledOnce()
    expect(m.core.open).not.toHaveBeenCalled()
    expect(m.editor.takeState).not.toHaveBeenCalled()
    expect(m.refresh).toHaveBeenCalledOnce()
    expect(m.agentWrites.reload).toHaveBeenCalledOnce()
  })

  it("hands the open note's editor what the write changed", async () => {
    const m = merging(unchanged('n2'))
    window.dispatchEvent(dbChanged())
    await settle()
    expect(m.core.open).toHaveBeenCalledWith('n1', VECTOR)
    expect(m.editor.takeState).toHaveBeenCalledWith(STATE)
  })

  it('shows a title the write gave the open note, though its body did not change', async () => {
    const m = merging(async () => ({
      retitled: [{ id: 'n1', title: 'Renamed' }],
      unchanged: ['n1'],
    }))
    window.dispatchEvent(dbChanged())
    await settle()
    expect(m.setTitle).toHaveBeenCalledWith('Renamed')
    expect(m.editor.takeState).not.toHaveBeenCalled()
  })

  it('patches the rows of the notes a write names instead of listing everything again', async () => {
    const m = merging(unchanged('n1'))
    window.dispatchEvent(dbChanged(['n2']))
    await settle()
    expect(m.patch).toHaveBeenCalledWith(m.core, ['n2'])
    expect(m.refresh).not.toHaveBeenCalled()
  })

  it('lists everything again when a write that arrived meanwhile names no notes', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const m = merging(async () => {
      await gate
      return { retitled: [], unchanged: ['n1'] }
    })
    window.dispatchEvent(dbChanged(['n2']))
    await settle()
    window.dispatchEvent(dbChanged(['n3']))
    window.dispatchEvent(dbChanged())
    release()
    await settle()
    await settle()
    expect(m.patch.mock.calls).toEqual([[m.core, ['n2']]])
    expect(m.refresh).toHaveBeenCalledOnce()
  })
})
