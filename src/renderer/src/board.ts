// The board layout of the note list: one column per status, in the order of
// NOTE_STATUSES, the notes of each in the order the list has them. A move sets
// the status of every note named through the note service; the board keeps
// its moves so each one undoes as one step.
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import { entryOffsets, windowRuns } from './listWindow'

interface Card {
  id: string
  status: NoteStatus
}

export interface BoardColumn<T extends Card> {
  status: NoteStatus
  notes: T[]
}

export function boardStatuses(showDropped: boolean): NoteStatus[] {
  return NOTE_STATUSES.filter((status) => showDropped || status !== 'dropped')
}

/** Every column of `statuses`, empty ones too; a note of another status is not on the board. */
export function boardColumns<T extends Card>(
  notes: readonly T[],
  statuses: readonly NoteStatus[],
): BoardColumn<T>[] {
  const columns = statuses.map((status) => ({ status, notes: [] as T[] }))
  const byStatus = new Map(columns.map((c) => [c.status, c]))
  for (const note of notes) byStatus.get(note.status)?.notes.push(note)
  return columns
}

/** The cards column by column, for selecting ranges and stepping through the notes. */
export function boardOrder(columns: readonly BoardColumn<Card>[]): string[] {
  return columns.flatMap((c) => c.notes.map((n) => n.id))
}

/**
 * The card an arrow key moves to from `from`: up and down within its column,
 * left and right to the same place in the nearest column with cards (its
 * last card when it has fewer). Undefined at an edge.
 */
export function cardStep(
  columns: readonly BoardColumn<Card>[],
  from: string,
  direction: 'up' | 'down' | 'left' | 'right',
): string | undefined {
  const at = columns.findIndex((c) => c.notes.some((n) => n.id === from))
  const column = columns[at]
  if (!column) return undefined
  const index = column.notes.findIndex((n) => n.id === from)
  if (direction === 'up' || direction === 'down') {
    return column.notes[index + (direction === 'down' ? 1 : -1)]?.id
  }
  const by = direction === 'right' ? 1 : -1
  for (let i = at + by; i >= 0 && i < columns.length; i += by) {
    const cards = columns[i]!.notes
    if (cards.length > 0) return cards[Math.min(index, cards.length - 1)]!.id
  }
  return undefined
}

/**
 * The card Home, End, Page Up or Page Down moves to from `from`: the first or
 * last, or the first card of the nearest column a page away. Undefined for
 * other keys and at the board's edge.
 */
export function boardJump(
  columns: readonly BoardColumn<Card>[],
  from: string,
  key: string,
): string | undefined {
  const order = boardOrder(columns)
  if (key === 'Home') return order[0]
  if (key === 'End') return order.at(-1)
  const by = key === 'PageDown' ? 1 : key === 'PageUp' ? -1 : 0
  if (!by) return undefined
  const at = columns.findIndex((c) => c.notes.some((n) => n.id === from))
  for (let i = at + by; i >= 0 && i < columns.length; i += by) {
    const cards = columns[i]!.notes
    if (cards.length > 0) return cards[0]!.id
  }
  return undefined
}

/**
 * The card Home, End, Page Up or Page Down moves to from a column that has the
 * keyboard while no card does: a page away from that column, not from the
 * board's first one. Undefined for other keys and at the board's edge.
 */
export function columnJump(
  columns: readonly BoardColumn<Card>[],
  status: NoteStatus,
  key: string,
): string | undefined {
  const order = boardOrder(columns)
  if (key === 'Home') return order[0]
  if (key === 'End') return order.at(-1)
  const by = key === 'PageDown' ? 1 : key === 'PageUp' ? -1 : 0
  if (!by) return undefined
  const at = columns.findIndex((c) => c.status === status)
  for (let i = at + by; i >= 0 && i < columns.length; i += by) {
    const cards = columns[i]!.notes
    if (cards.length > 0) return cards[0]!.id
  }
  return undefined
}

/** The status of the column next to `from`'s, if there is one. */
export function statusStep(
  statuses: readonly NoteStatus[],
  from: NoteStatus,
  by: 1 | -1,
): NoteStatus | undefined {
  const at = statuses.indexOf(from)
  return at < 0 ? undefined : statuses[at + by]
}

export interface StatusChange {
  id: string
  from: NoteStatus
  to: NoteStatus
}

export type BoardMove = readonly StatusChange[]

/** What moving `ids` to `to` changes: the notes listed that have another status. */
export function moveChanges(
  notes: readonly Card[],
  ids: readonly string[],
  to: NoteStatus,
): BoardMove {
  const byId = new Map(notes.map((n) => [n.id, n]))
  return ids.flatMap((id) => {
    const note = byId.get(id)
    return note && note.status !== to ? [{ id, from: note.status, to }] : []
  })
}

/** What moving each of `ids` one column on (`by`) from its own changes; a note in the last column stays. */
export function stepChanges(
  notes: readonly Card[],
  ids: readonly string[],
  statuses: readonly NoteStatus[],
  by: 1 | -1,
): BoardMove {
  const byId = new Map(notes.map((n) => [n.id, n]))
  return ids.flatMap((id) => {
    const note = byId.get(id)
    const to = note && statusStep(statuses, note.status, by)
    return note && to ? [{ id, from: note.status, to }] : []
  })
}

/** The changes that take `move` back, for the notes that still have the status it gave them. */
export function undoChanges(move: BoardMove, notes: readonly Card[]): BoardMove {
  const byId = new Map(notes.map((n) => [n.id, n]))
  return move.flatMap((change) =>
    byId.get(change.id)?.status === change.to
      ? [{ id: change.id, from: change.to, to: change.from }]
      : [],
  )
}

/** The changes that make `move` again, for the notes that still have the status it found. */
export function redoChanges(move: BoardMove, notes: readonly Card[]): BoardMove {
  const byId = new Map(notes.map((n) => [n.id, n]))
  return move.filter((change) => byId.get(change.id)?.status === change.from)
}

/** The notes of `changes` by the status they get, one write per status. */
export function changesByStatus(changes: BoardMove): [NoteStatus, string[]][] {
  const out = new Map<NoteStatus, string[]>()
  for (const change of changes) {
    const ids = out.get(change.to) ?? []
    ids.push(change.id)
    out.set(change.to, ids)
  }
  return [...out]
}

/** `changes` without the notes whose write failed. */
export function appliedChanges(changes: BoardMove, failed: readonly string[]): BoardMove {
  const missed = new Set(failed)
  return changes.filter((change) => !missed.has(change.id))
}

const MOVES_KEPT = 50

/**
 * The moves made on a board, for Undo and Redo; a new move drops the ones
 * undone. Undo and Redo take what a move changes now (`changesNow`) and pass
 * over a move that changes nothing any more, so a key press is never spent on one.
 */
export function createMoveHistory(limit = MOVES_KEPT) {
  let done: BoardMove[] = []
  let undone: BoardMove[] = []
  const take = (from: BoardMove[], to: BoardMove[], changesNow: (move: BoardMove) => BoardMove) => {
    for (let move = from.pop(); move; move = from.pop()) {
      const changes = changesNow(move)
      if (changes.length === 0) continue
      to.push(move)
      return changes
    }
    return undefined
  }
  return {
    record(move: BoardMove) {
      if (move.length === 0) return
      done = [...done, move].slice(-limit)
      undone = []
    },
    /** Puts what `move`'s write made (`applied`) in its place; a move that made nothing is dropped. */
    settle(move: BoardMove, applied: BoardMove) {
      const swap = (moves: BoardMove[]) =>
        moves.flatMap((m) => (m !== move ? [m] : applied.length > 0 ? [applied] : []))
      done = swap(done)
      undone = swap(undone)
    },
    undo: (changesNow: (move: BoardMove) => BoardMove) => take(done, undone, changesNow),
    redo: (changesNow: (move: BoardMove) => BoardMove) => take(undone, done, changesNow),
  }
}

export type MoveHistory = ReturnType<typeof createMoveHistory>

const BOARDS_KEPT = 20

/** A move history per board (by view key), in memory; the boards used longest ago are forgotten past `limit`. */
export function createBoardHistories(limit = BOARDS_KEPT) {
  const byView = new Map<string, MoveHistory>()
  return {
    forView(view: string): MoveHistory {
      const history = byView.get(view) ?? createMoveHistory()
      byView.delete(view)
      byView.set(view, history)
      for (const old of byView.keys()) {
        if (byView.size <= limit) break
        byView.delete(old)
      }
      return history
    },
  }
}

const OVERSCAN_PX = 600
const FIRST_CARDS = 30

export interface ColumnWindow {
  /** The cards to render, as sorted runs [start, end) of the column's cards. */
  runs: [number, number][]
  offsets: Float64Array
}

/**
 * The cards a column of a long board renders: those near the part that shows
 * (`view`, from the top of the first card; the first cards while the column
 * has not been measured) and each card of `kept` with its neighbours, so the
 * keyboard never loses its card.
 */
export function columnWindow(
  ids: readonly string[],
  heightOf: (id: string) => number,
  gap: number,
  view: { top: number; height: number } | undefined,
  kept: ReadonlySet<string>,
): ColumnWindow {
  const offsets = entryOffsets(ids.map(heightOf), gap)
  const keep: number[] = []
  ids.forEach((id, i) => {
    if (kept.has(id)) keep.push(i - 2, i - 1, i, i + 1, i + 2)
  })
  if (!view || view.height === 0) {
    for (let i = 0; i < Math.min(ids.length, FIRST_CARDS); i += 1) keep.push(i)
    return { runs: windowRuns(offsets, gap, null, 0, keep), offsets }
  }
  return { runs: windowRuns(offsets, gap, view, OVERSCAN_PX, keep), offsets }
}
