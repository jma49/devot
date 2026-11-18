// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveProblem, TakenIn } from '../../../core'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { DB_CHANGED } from '../externalChanges'
import { t } from '../i18n'
import { LICENCE_REQUIRED, LICENCE_UNREADABLE } from '../licence'
import { usePhoneData } from './usePhoneData'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))

const NOTE = { id: 'n1', title: 'From the Mac' }
let stored: { id: string; title: string }[] = []
const calls: string[] = []
let starting: 'started' | 'failed' = 'started'
let takenIn: ((change: TakenIn) => void) | undefined
let saveProblems: ((problems: SaveProblem[]) => void) | undefined

const core = {
  listWithTemplates: async () => {
    calls.push('listed')
    return { notes: stored, templates: [] }
  },
  listBooks: async () => [],
  listTags: async () => [],
  listSavedSearches: async () => [],
  listTrash: async () => [],
  mergeStored: async () => {
    calls.push('merged')
    return []
  },
  flush: async () => void calls.push('saved'),
}

vi.mock('../backups', () => ({ listBackups: async () => ({ backups: [] }) }))
vi.mock('../core-client', () => ({
  startCore: async (
    problems: (problems: SaveProblem[]) => void,
    _writes: unknown,
    _failed: unknown,
    windowed: unknown,
  ) => {
    saveProblems = problems
    takenIn = (windowed as { onTakenIn?: (change: TakenIn) => void } | undefined)?.onTakenIn
    if (starting === 'failed') throw new Error('E_CORE_START')
    return core
  },
  stopCore: () => {},
}))

afterEach(() => {
  unmountAll()
  stored = []
  calls.length = 0
  starting = 'started'
})

it('hands the native screens the core once it has started and the lists are read', async () => {
  const data = renderHook(() => usePhoneData(), { props: {} })
  const started = data.current.started()
  expect(await started).toBe(core)
  expect(calls).toContain('listed')
})

it('refuses the native screens the core when it failed to start', async () => {
  starting = 'failed'
  const data = renderHook(() => usePhoneData(), { props: {} })
  await expect(data.current.started()).rejects.toThrow('E_SCREENS_UNAVAILABLE')
})

it('merges what sync wrote into the notes in memory, saves them, then reloads the lists', async () => {
  const data = renderHook(() => usePhoneData(), { props: {} })
  await vi.waitFor(() => expect(data.current.core).not.toBeNull())
  stored = [NOTE]
  calls.length = 0
  act(() => void window.dispatchEvent(new CustomEvent(DB_CHANGED)))
  await vi.waitFor(() => expect(data.current.notes).toEqual([NOTE]))
  expect(calls).toEqual(['merged', 'saved', 'listed'])
})

it('tells the screens listening what a note in memory took in', async () => {
  const data = renderHook(() => usePhoneData(), { props: {} })
  await vi.waitFor(() => expect(data.current.core).not.toBeNull())
  const heard: TakenIn[] = []
  const stop = data.current.onTakenIn((change) => heard.push(change))
  const change: TakenIn = { kind: 'title', noteId: 'n1', title: 'Renamed' }
  takenIn?.(change)
  stop()
  takenIn?.({ kind: 'title', noteId: 'n1', title: 'Not heard' })
  expect(heard).toEqual([change])
})

describe('a note the core could not save', () => {
  const failing = (...problems: [string, string][]) =>
    act(() => saveProblems?.(problems.map(([id, code]) => ({ id, code }))))

  async function started() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSaveFailed = vi.fn<() => void>()
    const data = renderHook(() => usePhoneData(undefined, onSaveFailed), { props: {} })
    await vi.waitFor(() => expect(data.current.core).not.toBeNull())
    const logged = () => warn.mock.calls.filter(([code]) => code === 'W_NOTE_SAVE_FAILED')
    return { onSaveFailed, logged }
  }

  afterEach(() => vi.restoreAllMocks())

  it('is logged by ID and code and told to the screens once, until another note fails', async () => {
    const { onSaveFailed, logged } = await started()
    failing(['n1', 'E_STORAGE_SQLITE'])
    expect(logged()).toEqual([['W_NOTE_SAVE_FAILED', 'n1', 'E_STORAGE_SQLITE']])
    expect(onSaveFailed).toHaveBeenCalledTimes(1)
    failing(['n1', 'E_STORAGE_SQLITE'])
    expect(logged()).toHaveLength(1)
    expect(onSaveFailed).toHaveBeenCalledTimes(1)
    failing(['n1', 'E_STORAGE_SQLITE'], ['n2', 'E_STORAGE_SQLITE'])
    expect(logged().at(-1)).toEqual(['W_NOTE_SAVE_FAILED', 'n2', 'E_STORAGE_SQLITE'])
    expect(onSaveFailed).toHaveBeenCalledTimes(2)
  })

  it('is told again after every note saved, when one fails again', async () => {
    const { onSaveFailed, logged } = await started()
    failing(['n1', 'E_STORAGE_SQLITE'])
    failing()
    expect(onSaveFailed).toHaveBeenCalledTimes(1)
    failing(['n1', 'E_STORAGE_SQLITE'])
    expect(logged()).toHaveLength(2)
    expect(onSaveFailed).toHaveBeenCalledTimes(2)
  })

  it('refused for the licence is logged but leaves the toast to the Pro prompt', async () => {
    const { onSaveFailed, logged } = await started()
    failing(['n1', LICENCE_REQUIRED], ['n2', LICENCE_UNREADABLE])
    expect(logged()).toHaveLength(2)
    expect(onSaveFailed).not.toHaveBeenCalled()
  })
})

it('names the save toast from the catalog', () => {
  expect(t('phone.toast.saveFailed')).toBe('Could not save. Devot keeps trying.')
})
