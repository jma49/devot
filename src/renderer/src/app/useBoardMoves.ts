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
  const { changeBooks, runBatch, batchFailures, setBatchFailed } = libraryChanges
  // Status changes on a board view, however made (drops, keys, menus, the editor), are kept per view, in memory, so Undo and Redo on a board take back or make again the last one.
  const boardMoves = useRef<ReturnType<typeof createBoardHistories>>(undefined)
  const boardHistory = () => (boardMoves.current ??= createBoardHistories()).forView(listView)
  const recordStatus = (ids: readonly string[], status: NoteStatus) => {
    if (canBoard && editing) boardHistory().record(moveChanges(boardNotes, ids, status))
  }
  const setStatus = (noteId: string, status: NoteStatus) => {
    recordStatus([noteId], status)
    return changeBooks((c) => c.setStatus(noteId, status))
  }
  const setNotesStatus = (ids: readonly string[], status: NoteStatus) => {
    recordStatus(ids, status)
    return runBatch(ids, { kind: 'status', status })
  }

  /** Makes `changes`, resolving to those that were written. */
  const applyMove = async (changes: BoardMove): Promise<BoardMove> => {
    if (changes.length === 0) return changes
    setMovedTo((shown) => new Map([...shown, ...changes.map((c) => [c.id, c.to] as const)]))
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
    } finally {
      setMovedTo((shown) => {
        const left = new Map(shown)
        for (const c of changes) if (left.get(c.id) === c.to) left.delete(c.id)
        return left
      })
    }
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
