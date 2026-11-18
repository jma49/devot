import { describe, expect, it, vi } from 'vitest'
import { createBodySearchController } from './bodySearch'
import type { PaletteEntry } from './results'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const hit = (id: string, excerpt: string): PaletteEntry => ({
  kind: 'content',
  id,
  label: `Note ${id}`,
  excerpt,
})

describe('createBodySearchController', () => {
  it('ignores stale responses that finish after a newer query', async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<PaletteEntry[]>()
      const second = deferred<PaletteEntry[]>()
      const search = vi
        .fn<(q: string) => Promise<PaletteEntry[]>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      let current: readonly PaletteEntry[] = []
      const controller = createBodySearchController({
        search,
        debounceMs: 50,
        onResults: (rows) => {
          current = rows
        },
      })

      controller.update({ scope: null, query: 'al' })
      await vi.advanceTimersByTimeAsync(50)
      expect(search).toHaveBeenCalledWith('al')

      controller.update({ scope: null, query: 'alp' })
      await vi.advanceTimersByTimeAsync(50)
      expect(search).toHaveBeenCalledWith('alp')

      second.resolve([hit('n2', 'alpha')])
      await Promise.resolve()
      await Promise.resolve()
      expect(current.map((r) => r.id)).toEqual(['n2'])

      first.resolve([hit('n1', 'albatross')])
      await Promise.resolve()
      await Promise.resolve()
      expect(current.map((r) => r.id)).toEqual(['n2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears prior body matches synchronously as soon as the query changes before debounce settles', async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<PaletteEntry[]>()
      const second = deferred<PaletteEntry[]>()
      const search = vi
        .fn<(q: string) => Promise<PaletteEntry[]>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      let current: readonly PaletteEntry[] = []
      const controller = createBodySearchController({
        search,
        debounceMs: 60,
        onResults: (rows) => {
          current = rows
        },
      })

      controller.update({ scope: null, query: 'al' })
      await vi.advanceTimersByTimeAsync(60)
      first.resolve([hit('n1', 'alpha')])
      await Promise.resolve()
      await Promise.resolve()
      expect(current.map((r) => r.id)).toEqual(['n1'])

      // Extending "al" -> "alz" clears settled results immediately during the 60 ms debounce.
      controller.update({ scope: null, query: 'alz' })
      expect(current).toEqual([])
      expect(search).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60)
      expect(search).toHaveBeenCalledWith('alz')
      second.resolve([hit('n2', 'alzheimers')])
      await Promise.resolve()
      await Promise.resolve()
      expect(current.map((r) => r.id)).toEqual(['n2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears results and drops in-flight replies when cleared or closed or switched out of scope', async () => {
    vi.useFakeTimers()
    try {
      const pending = deferred<PaletteEntry[]>()
      const search = vi
        .fn<(q: string) => Promise<PaletteEntry[]>>()
        .mockReturnValue(pending.promise)
      let current: readonly PaletteEntry[] = [hit('prev', 'previous')]
      const controller = createBodySearchController({
        search,
        debounceMs: 50,
        onResults: (rows) => {
          current = rows
        },
      })

      controller.update({ scope: 'note', query: 'relay' })
      await vi.advanceTimersByTimeAsync(50)
      expect(search).toHaveBeenCalledWith('relay')

      controller.update({ scope: 'note', query: 'r' })
      expect(current).toEqual([])

      pending.resolve([hit('late', 'relay protocol')])
      await Promise.resolve()
      await Promise.resolve()
      expect(current).toEqual([])

      const pending2 = deferred<PaletteEntry[]>()
      search.mockReturnValueOnce(pending2.promise)
      controller.update({ scope: null, query: 'sync' })
      await vi.advanceTimersByTimeAsync(50)
      controller.reset()
      expect(current).toEqual([])
      pending2.resolve([hit('late2', 'sync engine')])
      await Promise.resolve()
      await Promise.resolve()
      expect(current).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles search rejections cleanly by leaving results empty', async () => {
    vi.useFakeTimers()
    try {
      const search = vi
        .fn<(q: string) => Promise<PaletteEntry[]>>()
        .mockRejectedValue(new Error('failed'))
      let current: readonly PaletteEntry[] = [hit('old', 'old')]
      const controller = createBodySearchController({
        search,
        debounceMs: 20,
        onResults: (rows) => {
          current = rows
        },
      })
      controller.update({ scope: null, query: 'err' })
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
      await Promise.resolve()
      expect(current).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
