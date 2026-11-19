// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../core'
import type { SearchScope } from '../../core/search'
import type { Core } from './core-client'
import { renderHook, unmountAll } from '../../../tests/support/render-hook'
import { useSearch, useSearchRuns } from './useSearch'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

function searching(core: Core | undefined, scope?: SearchScope) {
  const search = useSearch(core)
  useSearchRuns(search, { scope, inView: scope !== undefined })
  return search
}

function fakeCore(answer = (query: string) => Promise.resolve([{ id: query } as NoteSummary])) {
  const search = vi.fn<(query: string) => Promise<{ found: NoteSummary[]; capped: boolean }>>(
    async (query: string) => ({ found: await answer(query), capped: false }),
  )
  const searchByMeaning = vi.fn<Core['searchByMeaning']>(async () => [])
  return { search, searchByMeaning, core: { search, searchByMeaning } as unknown as Core }
}

describe('useSearch', () => {
  it('runs the query on the core once typing pauses', async () => {
    const { search, core } = fakeCore()
    const hook = renderHook(searching, { props: core })
    act(() => hook.current.setQuery('a'))
    act(() => hook.current.setQuery('ab'))
    expect(search).not.toHaveBeenCalled()
    await advance(120)
    expect(search).toHaveBeenCalledExactlyOnceWith('ab', undefined)
    expect(hook.current.results?.found).toEqual([{ id: 'ab' }])
  })

  it.each(['quasar', '\u540c\u6b65\u65b9'])(
    'runs the latest indexed query %s earlier',
    async (query) => {
      const { search, core } = fakeCore()
      const hook = renderHook(searching, { props: core })
      act(() => hook.current.setQuery('qua'))
      await advance(20)
      act(() => hook.current.setQuery(query))
      await advance(30)
      expect(search).not.toHaveBeenCalled()
      await advance(20)
      expect(search).toHaveBeenCalledExactlyOnceWith(query, undefined)
      expect(hook.current.results?.search.query).toBe(query)
    },
  )

  it.each(['body:ab', '\u540c\u6b65', '-exclude'])(
    'keeps the slower debounce for %s',
    async (query) => {
      const { search, core } = fakeCore()
      const hook = renderHook(searching, { props: core })
      act(() => hook.current.setQuery(query))
      act(() => hook.current.rerunSearch())
      await advance(119)
      expect(search).not.toHaveBeenCalled()
      await advance(1)
      expect(search).toHaveBeenCalledExactlyOnceWith(query, undefined)
    },
  )

  it('runs submitted search immediately without also executing the pending debounce', async () => {
    const { search, core } = fakeCore()
    const hook = renderHook(searching, { props: core })
    act(() => hook.current.setQuery('ab'))
    act(() => hook.current.submitSearch())
    expect(search).toHaveBeenCalledExactlyOnceWith('ab', undefined)
    await advance(120)
    expect(search).toHaveBeenCalledTimes(1)
    expect(hook.current.results?.search.query).toBe('ab')
  })

  it('runs a query typed before the core started once it has', async () => {
    const { search, core } = fakeCore()
    const hook = renderHook(searching, { props: undefined as Core | undefined })
    act(() => hook.current.setQuery('early'))
    await advance(120)
    hook.rerender(core)
    await advance(0)
    expect(search).toHaveBeenCalledExactlyOnceWith('early', undefined)
    expect(hook.current.results?.search.query).toBe('early')
  })

  it('does not run a pending query twice when the core starts during debounce', async () => {
    const { search, core } = fakeCore()
    const hook = renderHook(searching, { props: undefined as Core | undefined })
    act(() => hook.current.setQuery('early'))
    hook.rerender(core)
    await advance(120)
    expect(search).toHaveBeenCalledExactlyOnceWith('early', undefined)
  })

  it('drops an answer that lands after the field was cleared', async () => {
    let answer: (found: NoteSummary[]) => void = () => {}
    const { core } = fakeCore(() => new Promise((resolve) => (answer = resolve)))
    const hook = renderHook(searching, { props: core })
    act(() => hook.current.setQuery('slow'))
    await advance(120)
    act(() => hook.current.setQuery(''))
    answer([{ id: 'slow' } as NoteSummary])
    await advance(0)
    expect(hook.current.results).toBeUndefined()
  })

  it('drops superseded answers and does not start superseded queued queries', async () => {
    let answer: (found: NoteSummary[]) => void = () => {}
    const { core, search, searchByMeaning } = fakeCore((query: string) =>
      query === 'slow'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve([{ id: query } as NoteSummary]),
    )
    const hook = renderHook(searching, { props: core })
    act(() => hook.current.setQuery('slow'))
    await advance(120)
    act(() => hook.current.setQuery('queued'))
    await advance(120)
    act(() => hook.current.setQuery('ab'))
    answer([{ id: 'slow' } as NoteSummary])
    await advance(0)
    expect(hook.current.results).toBeUndefined()
    expect(searchByMeaning).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledExactlyOnceWith('slow', undefined)

    await advance(120)
    expect(search).toHaveBeenLastCalledWith('ab', undefined)
    expect(hook.current.results?.search.query).toBe('ab')
    expect(searchByMeaning).toHaveBeenCalledExactlyOnceWith('ab', undefined)
  })

  it('does not publish a result from the old scope for the same query', async () => {
    let answer: (found: NoteSummary[]) => void = () => {}
    const { core, search } = fakeCore(() => new Promise((resolve) => (answer = resolve)))
    const first: SearchScope = { bookId: 'first', filter: null }
    const next: SearchScope = { bookId: 'next', filter: null }
    const hook = renderHook((scope) => searching(core, scope), { props: first })
    act(() => hook.current.setQuery('same'))
    await advance(50)
    expect(search).toHaveBeenCalledExactlyOnceWith('same', first)
    hook.rerender(next)
    answer([{ id: 'wrong-scope' } as NoteSummary])
    await advance(0)
    expect(hook.current.results).toBeUndefined()

    await advance(50)
    expect(search).toHaveBeenLastCalledWith('same', next)
    answer([{ id: 'correct-scope' } as NoteSummary])
    await advance(0)
    expect(hook.current.results?.search.scope).toBe(next)
  })
})
