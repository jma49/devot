// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../core'
import type { Core } from './core-client'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import { useSearch, useSearchRuns } from './useSearch'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

afterEach(unmountAll)

const typingPaused = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)))

function searching(core: Core | undefined) {
  const search = useSearch(core)
  useSearchRuns(search, { scope: undefined, inView: false })
  return search
}

function fakeCore(answer = (query: string) => Promise.resolve([{ id: query } as NoteSummary])) {
  const search = vi.fn<(query: string) => Promise<{ found: NoteSummary[]; capped: boolean }>>(
    async (query: string) => ({ found: await answer(query), capped: false }),
  )
  return { search, core: { search } as unknown as Core }
}

describe('useSearch', () => {
  it('runs the query on the core once typing pauses', async () => {
    const { search, core } = fakeCore()
    const hook = renderHook(searching, { props: core })
    act(() => hook.current.setQuery('a'))
    act(() => hook.current.setQuery('ab'))
    expect(search).not.toHaveBeenCalled()
    await typingPaused()
    expect(search).toHaveBeenCalledExactlyOnceWith('ab', undefined)
    expect(hook.current.results?.found).toEqual([{ id: 'ab' }])
  })

  it('runs a query typed before the core started once it has', async () => {
    const { search, core } = fakeCore()
    const hook = renderHook(searching, { props: undefined as Core | undefined })
    act(() => hook.current.setQuery('early'))
    await typingPaused()
    hook.rerender(core)
    await settle()
    expect(search).toHaveBeenCalledExactlyOnceWith('early', undefined)
    expect(hook.current.results?.search.query).toBe('early')
  })

  it('drops an answer that lands after the field was cleared', async () => {
    let answer: (found: NoteSummary[]) => void = () => {}
    const { core } = fakeCore(() => new Promise((resolve) => (answer = resolve)))
    const hook = renderHook(searching, { props: core })
    act(() => hook.current.setQuery('slow'))
    await typingPaused()
    act(() => hook.current.setQuery(''))
    answer([{ id: 'slow' } as NoteSummary])
    await settle()
    expect(hook.current.results).toBeUndefined()
  })
})
