// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeptDrawing } from '../../../core/plugins/drawings'
import { dbChanged } from '../externalChanges'
import {
  findKeptDrawing,
  keptDrawingsChanged,
  keptDrawingsOf,
  keptDrawingsRevision,
  loadKeptDrawings,
  watchKeptDrawings,
} from './keptDrawings'

type Read = (id: string) => Promise<readonly KeptDrawing[]>

const HASH = 'a'.repeat(64)
const kept = (svg: string, over: Partial<KeptDrawing> = {}): KeptDrawing => ({
  pluginId: 'com.example.graphviz',
  language: 'dot',
  hash: HASH,
  appearance: 'light',
  svg,
  ...over,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  keptDrawingsChanged()
  vi.restoreAllMocks()
})

let at = 0
const noteId = () => `0192a6f0-0000-7000-8000-${String((at += 1)).padStart(12, '0')}`

describe('the kept drawings a window reads', () => {
  it('reads a note once for loads made at once', async () => {
    const id = noteId()
    const read = vi.fn<Read>(async () => [kept('<svg/>')])
    const [x, y] = await Promise.all([loadKeptDrawings(read, id), loadKeptDrawings(read, id)])
    expect(x).toEqual([kept('<svg/>')])
    expect(y).toBe(x)
    await loadKeptDrawings(read, id)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not keep a failed read, so the next load reads again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = noteId()
    const read = vi
      .fn<Read>()
      .mockRejectedValueOnce(new Error('E_CORE_NOT_READY'))
      .mockResolvedValueOnce([kept('<svg/>')])
    expect(await loadKeptDrawings(read, id)).toBeUndefined()
    expect(keptDrawingsOf(id)).toBeUndefined()
    expect(await loadKeptDrawings(read, id)).toEqual([kept('<svg/>')])
  })

  it('keeps the list shown until a read after a change answers, and draws again only when it changed', async () => {
    const id = noteId()
    const changed = vi.fn<() => void>()
    stops.push(watchKeptDrawings(() => id, changed))
    const answers = [deferred<readonly KeptDrawing[]>(), deferred<readonly KeptDrawing[]>()]
    let reads = 0
    const read = vi.fn<Read>(async () =>
      reads++ === 0 ? [kept('<svg>1</svg>')] : answers[reads - 2]!.promise,
    )
    await loadKeptDrawings(read, id)
    const revision = keptDrawingsRevision()

    window.dispatchEvent(dbChanged())
    expect(read).toHaveBeenCalledTimes(2)
    expect(keptDrawingsOf(id)).toEqual([kept('<svg>1</svg>')])
    answers[0]!.resolve([kept('<svg>1</svg>')])
    await vi.waitFor(() => expect(reads).toBe(2))
    await answers[0]!.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changed).not.toHaveBeenCalled()
    expect(keptDrawingsRevision()).toBe(revision)

    window.dispatchEvent(dbChanged())
    expect(keptDrawingsOf(id)).toEqual([kept('<svg>1</svg>')])
    answers[1]!.resolve([kept('<svg>2</svg>')])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(keptDrawingsOf(id)).toEqual([kept('<svg>2</svg>')])
    expect(keptDrawingsRevision()).not.toBe(revision)
  })

  it('reads again only the notes a change names', async () => {
    const id = noteId()
    stops.push(
      watchKeptDrawings(
        () => id,
        () => {},
      ),
    )
    const read = vi.fn<Read>(async () => [kept('<svg/>')])
    await loadKeptDrawings(read, id)
    window.dispatchEvent(dbChanged([noteId()]))
    expect(read).toHaveBeenCalledTimes(1)
    window.dispatchEvent(dbChanged([id]))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not take an answer asked before a change', async () => {
    const id = noteId()
    const first = deferred<readonly KeptDrawing[]>()
    const read = vi
      .fn<Read>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([kept('<svg>new</svg>')])
    const loading = loadKeptDrawings(read, id)
    keptDrawingsChanged(new Set([id]))
    first.resolve([kept('<svg>old</svg>')])
    expect(await loading).toEqual([kept('<svg>new</svg>')])
    expect(keptDrawingsOf(id)).toEqual([kept('<svg>new</svg>')])
  })

  it('lets go of a note no window shows when it changes', async () => {
    const id = noteId()
    await loadKeptDrawings(async () => [kept('<svg/>')], id)
    keptDrawingsChanged(new Set([id]))
    expect(keptDrawingsOf(id)).toBeUndefined()
  })
})

describe('finding a kept drawing', () => {
  it('matches the language, the hash and the appearance, the same one whatever the order', () => {
    const list = [
      kept('<svg>g</svg>'),
      kept('<svg>o</svg>', { pluginId: 'org.other.dot' }),
      kept('<svg>d</svg>', { appearance: 'dark' }),
    ]
    const block = { language: 'dot', hash: HASH, appearance: 'light' } as const
    expect(findKeptDrawing(list, block)?.pluginId).toBe('org.other.dot')
    expect(findKeptDrawing([...list].reverse(), block)?.pluginId).toBe('org.other.dot')
    expect(findKeptDrawing(list, { ...block, appearance: 'dark' })?.svg).toBe('<svg>d</svg>')
    expect(findKeptDrawing(list, { ...block, hash: 'b'.repeat(64) })).toBeUndefined()
    expect(findKeptDrawing(list, { ...block, language: 'd2' })).toBeUndefined()
  })
})
