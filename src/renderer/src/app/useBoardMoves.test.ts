// @vitest-environment happy-dom
import { act, useMemo, useState, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BatchChange, NoteStatus } from '../../../core'
import type { Core } from '../core-client'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import { useBoardMoves } from './useBoardMoves'
import type { LibraryChanges } from './useLibraryChanges'
import type { ViewState } from './useLibraryView'

afterEach(unmountAll)

interface Card {
  id: string
  status: NoteStatus
}

/** A library whose writes reach the store at once but reach the lists only on `release`, while `hold` is on. */
function fakeLibrary(initial: Record<string, NoteStatus>, refused: readonly string[] = []) {
  const stored = new Map(Object.entries(initial) as [string, NoteStatus][])
  const writes: string[] = []
  const listeners = new Set<() => void>()
  let gate: Promise<void> | undefined
  let open = () => {}
  const read = (): Card[] => [...stored].map(([id, status]) => ({ id, status }))
  let listed = read()
  const write = (ids: readonly string[], status: NoteStatus) => {
    writes.push(`${ids.join(',')} ${status}`)
    const failed = ids.filter((id) => refused.includes(id))
    for (const id of ids) if (!failed.includes(id)) stored.set(id, status)
    return failed
  }
  const refresh = async () => {
    await gate
    listed = read()
    for (const listener of listeners) listener()
  }
  const core = {
    setStatus: async (id: string, status: NoteStatus) => {
      if (write([id], status).length > 0) throw new Error('E_REFUSED')
    },
  } as unknown as Core
  const batchFailures = async (ids: readonly string[], change: BatchChange) => {
    const failed = change.kind === 'status' ? write(ids, change.status) : []
    await refresh()
    return failed
  }
  const changes = {
    changeBooks: async (change: (c: Core) => Promise<unknown>) => {
      await change(core).catch(() => {})
      await refresh()
    },
    batchFailures,
    runBatch: async (ids: readonly string[], change: BatchChange) => {
      await batchFailures(ids, change)
    },
    setBatchFailed: () => {},
  } as unknown as LibraryChanges
  return {
    changes,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listed: () => listed,
    writes,
    stored,
    hold: () => {
      gate = new Promise((resolve) => (open = resolve))
    },
    release: () => {
      gate = undefined
      open()
    },
  }
}

type Library = ReturnType<typeof fakeLibrary>

function useBoard({ library }: { library: Library }) {
  const notes = useSyncExternalStore(library.subscribe, library.listed)
  const [movedTo, setMovedTo] = useState<ReadonlyMap<string, NoteStatus>>(() => new Map())
  const boardNotes = useMemo(
    () => notes.map((n) => ({ ...n, status: movedTo.get(n.id) ?? n.status })),
    [notes, movedTo],
  )
  const view = {
    listView: 'all',
    canBoard: true,
    boardNotes,
    boardStatusList: ['none', 'active', 'on_hold', 'completed'],
    setMovedTo,
  } as unknown as ViewState
  return {
    moves: useBoardMoves({ view, editing: true, libraryChanges: library.changes }),
    boardNotes,
  }
}

/** Alpha moved to On Hold, written and listed. */
async function boardAfterOneMove(refused: readonly string[] = []) {
  const library = fakeLibrary({ alpha: 'none', bravo: 'none' }, refused)
  const hook = renderHook(useBoard, { props: { library } })
  act(() => hook.current.moves.moveCards(['alpha'], 'on_hold'))
  await settle()
  library.writes.length = 0
  return { library, hook }
}

type Moves = ReturnType<typeof useBoardMoves>

const bravoToActive: [string, (m: Moves) => Promise<void>][] = [
  ['setStatus', (m) => m.setStatus('bravo', 'active')],
  ['setNotesStatus', (m) => m.setNotesStatus(['bravo'], 'active')],
]

describe('useBoardMoves', () => {
  it.each(bravoToActive)(
    'an Undo before %s has reached the lists takes that change back, not the older move',
    async (_, change) => {
      const { library, hook } = await boardAfterOneMove()
      library.hold()
      act(() => void change(hook.current.moves))
      act(() => hook.current.moves.undoMove())
      library.release()
      await settle()
      expect(library.writes).toEqual(['bravo active', 'bravo none'])
      expect(Object.fromEntries(library.stored)).toEqual({ alpha: 'on_hold', bravo: 'none' })
    },
  )

  it.each(bravoToActive)(
    'a %s whose write fails shows nothing and leaves the older move to Undo',
    async (_, change) => {
      const { library, hook } = await boardAfterOneMove(['bravo'])
      await act(() => change(hook.current.moves))
      expect(hook.current.boardNotes.find((n) => n.id === 'bravo')?.status).toBe('none')
      act(() => hook.current.moves.undoMove())
      await settle()
      expect(library.writes).toEqual(['bravo active', 'alpha none'])
    },
  )
})
