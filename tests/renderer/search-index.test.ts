import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '../../src/renderer/src/ipc'
import { rebuildSearchIndex, type RebuildState } from '../../src/renderer/src/searchIndex'

vi.mock('../../src/renderer/src/ipc', () => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

it('shows running, reloads, then shows how many notes were covered', async () => {
  vi.mocked(invoke).mockResolvedValue(7)
  const states: RebuildState[] = []
  const reload = vi.fn<() => Promise<void>>(async () => {
    expect(states).toEqual([{ phase: 'running' }])
  })
  await rebuildSearchIndex((s) => states.push(s), reload)
  expect(invoke).toHaveBeenCalledWith('search_index_rebuild')
  expect(reload).toHaveBeenCalledTimes(1)
  expect(states).toEqual([{ phase: 'running' }, { phase: 'done', notes: 7 }])
})

it('reports the error code and does not reload when the rebuild fails', async () => {
  vi.mocked(invoke).mockImplementation(() => Promise.reject(new Error('E_SEARCH_REBUILD_BUSY')))
  const states: RebuildState[] = []
  const reload = vi.fn<() => Promise<void>>(async () => {})
  await rebuildSearchIndex((s) => states.push(s), reload)
  expect(reload).not.toHaveBeenCalled()
  expect(states).toEqual([{ phase: 'running' }, { phase: 'failed', code: 'E_SEARCH_REBUILD_BUSY' }])
})

it('still reports success when the reload after it fails', async () => {
  vi.mocked(invoke).mockResolvedValue(2)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const states: RebuildState[] = []
  await rebuildSearchIndex(
    (s) => states.push(s),
    async () => {
      throw new Error('E_X')
    },
  )
  expect(states.at(-1)).toEqual({ phase: 'done', notes: 2 })
})
