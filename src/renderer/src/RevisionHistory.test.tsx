// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffBlock, HistoryEntry } from '../../core'
import { settle } from '../../../tests/support/render-hook'
import type { Core } from './core-client'
import { RevisionHistory } from './RevisionHistory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const version = (id: string, at: number): HistoryEntry => ({
  id,
  kind: 'body',
  at,
  length: 10,
  change: 2,
  merge: false,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fakeCore() {
  const lists: ReturnType<typeof deferred<HistoryEntry[]>>[] = []
  const diffs: { id: string; answer: ReturnType<typeof deferred<DiffBlock[]>> }[] = []
  const restores: ReturnType<typeof deferred<Uint8Array>>[] = []
  const core = {
    headlines: vi.fn<() => Promise<Record<string, string>>>(() => Promise.resolve({})),
    history: vi.fn<() => Promise<HistoryEntry[]>>(() => {
      const answer = deferred<HistoryEntry[]>()
      lists.push(answer)
      return answer.promise
    }),
    compareRevision: vi.fn<(note: string, id: string) => Promise<DiffBlock[]>>((_note, id) => {
      const answer = deferred<DiffBlock[]>()
      diffs.push({ id, answer })
      return answer.promise
    }),
    restoreRevision: vi.fn<() => Promise<Uint8Array>>(() => {
      const answer = deferred<Uint8Array>()
      restores.push(answer)
      return answer.promise
    }),
  }
  return { core, lists, diffs, restores }
}

let root: Root | undefined
let host: HTMLElement
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  host?.remove()
})

type Props = Parameters<typeof RevisionHistory>[0]
function render(props: Props) {
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root!.render(<RevisionHistory {...props} />))
}

const base = (core: unknown, extra: Partial<Props> = {}): Props => ({
  core: core as Core,
  noteId: 'n',
  title: 'Note',
  books: [],
  inline: true,
  onRestore: () => {},
  ...extra,
})

const rows = () => [...host.querySelectorAll('.history-row')].map((row) => row.textContent)
const diffText = () => host.querySelector('.diff')?.textContent ?? ''

describe('the inline revision history', () => {
  it('fetches nothing while hidden and reads the versions again each time it shows', async () => {
    const { core } = fakeCore()
    render(base(core, { shown: false }))
    await settle()
    expect(core.history).not.toHaveBeenCalled()
    render(base(core, { shown: true }))
    expect(core.history).toHaveBeenCalledTimes(1)
    render(base(core, { shown: false }))
    render(base(core, { shown: true }))
    expect(core.history).toHaveBeenCalledTimes(2)
  })

  it('reads the versions again when the note is saved and drops the older answer', async () => {
    const { core, lists } = fakeCore()
    render(base(core, { updatedAt: 1 }))
    render(base(core, { updatedAt: 2 }))
    expect(core.history).toHaveBeenCalledTimes(2)
    lists[1]!.resolve([version('new', 2_000), version('old', 1_000)])
    await settle()
    lists[0]!.resolve([version('old', 1_000)])
    await settle()
    expect(rows()).toHaveLength(2)
  })

  it('shows only the comparison for the version picked last', async () => {
    const { core, lists, diffs } = fakeCore()
    render(base(core))
    lists[0]!.resolve([version('b', 2_000), version('a', 1_000)])
    await settle()
    act(() => (host.querySelectorAll('.history-row')[1] as HTMLElement).click())
    expect(diffs.map((d) => d.id)).toEqual(['b', 'a'])
    diffs[1]!.answer.resolve([{ kind: 'added', text: 'from a' }])
    await settle()
    diffs[0]!.answer.resolve([{ kind: 'added', text: 'from b' }])
    await settle()
    expect(diffText()).toContain('from a')
    expect(diffText()).not.toContain('from b')
  })

  it('restores once, then reads the versions again; a restore answered after unmount does nothing', async () => {
    const { core, lists, diffs, restores } = fakeCore()
    const onRestore = vi.fn<(update: Uint8Array) => void>()
    render(base(core, { onRestore }))
    lists[0]!.resolve([version('a', 1_000)])
    await settle()
    diffs[0]!.answer.resolve([{ kind: 'removed', text: 'gone' }])
    await settle()
    const restore = [...host.querySelectorAll('button')].find(
      (button) => !button.disabled && button.closest('.confirm-actions'),
    )!
    act(() => restore.click())
    act(() => restore.click())
    expect(core.restoreRevision).toHaveBeenCalledTimes(1)
    restores[0]!.resolve(new Uint8Array([1]))
    await settle()
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(core.history).toHaveBeenCalledTimes(2)

    lists[1]!.resolve([version('a', 1_000)])
    await settle()
    diffs.at(-1)!.answer.resolve([{ kind: 'removed', text: 'gone' }])
    await settle()
    const onClose = vi.fn<() => void>()
    render(base(core, { onRestore, onClose, inline: true }))
    act(() => restore.click())
    act(() => root!.unmount())
    root = undefined
    restores[1]!.resolve(new Uint8Array([2]))
    await settle()
    expect(onClose).not.toHaveBeenCalled()
  })
})
