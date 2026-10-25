// The board layout of the note list: one column per status, in the order of
// NOTE_STATUSES, the notes of each in the order the list has them. A move sets
// the status of every note named through the note service; the board keeps
// its moves so each one undoes as one step.
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'

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

const MOVES_KEPT = 50

/** The moves made on a board, for Undo and Redo; a new move drops the ones undone. */
export function createMoveHistory(limit = MOVES_KEPT) {
  let done: BoardMove[] = []
  let undone: BoardMove[] = []
  return {
    record(move: BoardMove) {
      if (move.length === 0) return
      done = [...done, move].slice(-limit)
      undone = []
    },
    /** The move to take back, now counted as undone. */
    undo(): BoardMove | undefined {
      const move = done.pop()
      if (move) undone.push(move)
      return move
    },
    /** The move to make again, now counted as done. */
    redo(): BoardMove | undefined {
      const move = undone.pop()
      if (move) done.push(move)
      return move
    },
    clear() {
      done = []
      undone = []
    },
  }
}

export type MoveHistory = ReturnType<typeof createMoveHistory>
