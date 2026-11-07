import { useRef } from 'react'
import type { NoteStatus } from '../../../core'
import { errorCode } from '../backups'
import {
  appliedChanges,
  changesByStatus,
  createBoardHistories,
  moveChanges,
  redoChanges,
  stepChanges,
  undoChanges,
  type BoardMove,
} from '../board'
import { useStable } from '../stable'
import type { LibraryChanges } from './useLibraryChanges'
import type { ViewState } from './useLibraryView'

/** Status changes, and on a board the cards they move, with Undo and Redo per board view. */
export function useBoardMoves({
  view,
  editing,
  libraryChanges,
}: {
  view: ViewState
  editing: boolean
  libraryChanges: LibraryChanges
}) {
  const { listView, canBoard, boardNotes, boardStatusList, setMovedTo } = view
  const { changeBooks, batchFailures, setBatchFailed } = libraryChanges
  // Status changes on a board view, however made (drops, keys, menus, the editor), are kept per view, in memory, so Undo and Redo on a board take back or make again the last one.
  const boardMoves = useRef<ReturnType<typeof createBoardHistories>>(undefined)
  const boardHistory = () => (boardMoves.current ??= createBoardHistories()).forView(listView)
  // The board shows changes before the lists have them, so an Undo straight after one finds it there.
  const showWhile = async <T>(changes: BoardMove, write: () => Promise<T>): Promise<T> => {
    if (changes.length === 0) return write()
    setMovedTo((shown) => new Map([...shown, ...changes.map((c) => [c.id, c.to] as const)]))
    try {
      return await write()
    } finally {
      setMovedTo((shown) => {
        const left = new Map(shown)
        for (const c of changes) if (left.get(c.id) === c.to) left.delete(c.id)
        return left
      })
    }
  }
  const writeStatus = async (
    ids: readonly string[],
    status: NoteStatus,
    writeFailures: () => Promise<readonly string[]>,
  ) => {
    const changes = moveChanges(boardNotes, ids, status)
    const history = canBoard && editing ? boardHistory() : undefined
    history?.record(changes)
    let failed: readonly string[] = ids
    try {
      failed = await showWhile(changes, writeFailures)
    } finally {
      const applied = appliedChanges(changes, failed)
      if (applied.length < changes.length) history?.settle(changes, applied)
    }
  }
  const setStatus = (noteId: string, status: NoteStatus) =>
    writeStatus([noteId], status, async () => {
      let written = false
      await changeBooks(async (c) => {
        await c.setStatus(noteId, status)
        written = true
      })
      return written ? [] : [noteId]
    })
  const setNotesStatus = (ids: readonly string[], status: NoteStatus) =>
    writeStatus(ids, status, () => batchFailures(ids, { kind: 'status', status }))

  /** Makes `changes`, resolving to those that were written. */
  const applyMove = async (changes: BoardMove): Promise<BoardMove> => {
    if (changes.length === 0) return changes
    return showWhile(changes, async () => {
      const failed: string[] = []
      try {
        for (const [status, ids] of changesByStatus(changes)) {
          failed.push(...(await batchFailures(ids, { kind: 'status', status }, { notice: false })))
        }
        // One notice for the whole move, with every card whose write failed.
        if (failed.length > 0) setBatchFailed(failed.length)
        return appliedChanges(changes, failed)
      } catch (e) {
        console.warn('W_BOARD_MOVE_FAILED', errorCode(e))
        return []
      }
    })
  }
  const recordMove = (changes: BoardMove) => {
    if (!editing || changes.length === 0) return
    const history = boardHistory()
    history.record(changes)
    void applyMove(changes).then((applied) => {
      if (applied.length < changes.length) history.settle(changes, applied)
    })
  }
  const moveCards = useStable((ids: readonly string[], status: NoteStatus) =>
    recordMove(moveChanges(boardNotes, ids, status)),
  )
  const stepCards = useStable((ids: readonly string[], by: 1 | -1) =>
    recordMove(stepChanges(boardNotes, ids, boardStatusList, by)),
  )
  const undoMove = useStable(() => {
    if (!editing) return
    const changes = boardHistory().undo((move) => undoChanges(move, boardNotes))
    if (changes) void applyMove(changes)
  })
  const redoMove = useStable(() => {
    if (!editing) return
    const changes = boardHistory().redo((move) => redoChanges(move, boardNotes))
    if (changes) void applyMove(changes)
  })

  return { setStatus, setNotesStatus, moveCards, stepCards, undoMove, redoMove }
}
