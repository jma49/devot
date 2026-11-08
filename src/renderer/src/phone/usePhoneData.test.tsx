// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TakenIn } from '../../../core'
import { renderHook, unmountAll } from '../../../../tests/support/render-hook'
import { DB_CHANGED } from '../externalChanges'
import { usePhoneData } from './usePhoneData'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: true }))

const NOTE = { id: 'n1', title: 'From the Mac' }
let stored: { id: string; title: string }[] = []
const calls: string[] = []
let starting: 'started' | 'failed' = 'started'
let takenIn: ((change: TakenIn) => void) | undefined

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
  startCore: async (_problems: unknown, _writes: unknown, _failed: unknown, windowed: unknown) => {
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
