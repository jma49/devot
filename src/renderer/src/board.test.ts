import { describe, expect, it } from 'vitest'
import type { NoteStatus } from '../../core/storage'
import {
  boardColumns,
  boardOrder,
  boardStatuses,
  cardStep,
  changesByStatus,
  createMoveHistory,
  moveChanges,
  redoChanges,
  statusStep,
  stepChanges,
  undoChanges,
} from './board'

const note = (id: string, status: NoteStatus) => ({ id, status })

const notes = [
  note('a', 'active'),
  note('b', 'none'),
  note('c', 'active'),
  note('d', 'completed'),
  note('e', 'dropped'),
  note('f', 'active'),
]

describe('boardStatuses', () => {
  it('shows the five statuses in order, Dropped last unless hidden', () => {
    expect(boardStatuses(true)).toEqual(['none', 'active', 'on_hold', 'completed', 'dropped'])
    expect(boardStatuses(false)).toEqual(['none', 'active', 'on_hold', 'completed'])
  })
})

describe('boardColumns', () => {
  it('puts each note in its status column, in the order listed, empty columns kept', () => {
    const columns = boardColumns(notes, boardStatuses(true))
    expect(columns.map((c) => [c.status, c.notes.map((n) => n.id)])).toEqual([
      ['none', ['b']],
      ['active', ['a', 'c', 'f']],
      ['on_hold', []],
      ['completed', ['d']],
      ['dropped', ['e']],
    ])
  })

  it('leaves out the notes of a hidden status', () => {
    const columns = boardColumns(notes, boardStatuses(false))
    expect(columns.map((c) => c.status)).not.toContain('dropped')
    expect(boardOrder(columns)).toEqual(['b', 'a', 'c', 'f', 'd'])
  })
})

describe('cardStep', () => {
  const columns = boardColumns(notes, boardStatuses(true))

  it('moves up and down within a column and stops at its ends', () => {
    expect(cardStep(columns, 'a', 'down')).toBe('c')
    expect(cardStep(columns, 'c', 'up')).toBe('a')
    expect(cardStep(columns, 'a', 'up')).toBeUndefined()
    expect(cardStep(columns, 'f', 'down')).toBeUndefined()
  })

  it('moves sideways to the same place in the next column with cards, or its last card', () => {
    expect(cardStep(columns, 'c', 'left')).toBe('b')
    expect(cardStep(columns, 'b', 'right')).toBe('a')
    // On Hold is empty: Completed is next.
    expect(cardStep(columns, 'f', 'right')).toBe('d')
    expect(cardStep(columns, 'd', 'left')).toBe('a')
    expect(cardStep(columns, 'e', 'right')).toBeUndefined()
    expect(cardStep(columns, 'b', 'left')).toBeUndefined()
  })

  it('has nowhere to go from a card not on the board', () => {
    expect(cardStep(columns, 'gone', 'down')).toBeUndefined()
  })
})

describe('statusStep', () => {
  it('is the column next to a status, none past the ends or the hidden one', () => {
    expect(statusStep(boardStatuses(true), 'none', 1)).toBe('active')
    expect(statusStep(boardStatuses(true), 'active', -1)).toBe('none')
    expect(statusStep(boardStatuses(true), 'none', -1)).toBeUndefined()
    expect(statusStep(boardStatuses(true), 'completed', 1)).toBe('dropped')
    expect(statusStep(boardStatuses(false), 'completed', 1)).toBeUndefined()
  })
})

describe('moveChanges', () => {
  it('lists each note that changes, with the status it leaves', () => {
    expect(moveChanges(notes, ['a', 'b', 'd'], 'completed')).toEqual([
      { id: 'a', from: 'active', to: 'completed' },
      { id: 'b', from: 'none', to: 'completed' },
    ])
    expect(moveChanges(notes, ['d', 'gone'], 'completed')).toEqual([])
  })
})

describe('stepChanges', () => {
  it('moves each note one column on from its own, past the ends not at all', () => {
    expect(stepChanges(notes, ['b', 'a', 'd', 'e'], boardStatuses(true), 1)).toEqual([
      { id: 'b', from: 'none', to: 'active' },
      { id: 'a', from: 'active', to: 'on_hold' },
      { id: 'd', from: 'completed', to: 'dropped' },
    ])
    expect(stepChanges(notes, ['b', 'a'], boardStatuses(true), -1)).toEqual([
      { id: 'a', from: 'active', to: 'none' },
    ])
    expect(stepChanges(notes, ['d'], boardStatuses(false), 1)).toEqual([])
  })
})

describe('undoChanges', () => {
  it('takes back the notes still where the move left them', () => {
    const move = [
      { id: 'a', from: 'none' as const, to: 'active' as const },
      { id: 'd', from: 'active' as const, to: 'on_hold' as const },
    ]
    // d was changed since by something else: it is left alone.
    expect(undoChanges(move, notes)).toEqual([{ id: 'a', from: 'active', to: 'none' }])
  })
})

describe('redoChanges', () => {
  it('makes the move again for the notes still where it found them', () => {
    const move = [
      { id: 'b', from: 'none' as const, to: 'active' as const },
      { id: 'd', from: 'active' as const, to: 'on_hold' as const },
    ]
    expect(redoChanges(move, notes)).toEqual([{ id: 'b', from: 'none', to: 'active' }])
  })
})

describe('changesByStatus', () => {
  it('groups the notes by the status they go to, in the order first seen', () => {
    expect(
      changesByStatus([
        { id: 'a', from: 'none', to: 'active' },
        { id: 'b', from: 'dropped', to: 'none' },
        { id: 'c', from: 'none', to: 'active' },
      ]),
    ).toEqual([
      ['active', ['a', 'c']],
      ['none', ['b']],
    ])
  })
})

describe('createMoveHistory', () => {
  const one = [{ id: 'a', from: 'none' as const, to: 'active' as const }]
  const two = [{ id: 'b', from: 'active' as const, to: 'completed' as const }]

  it('undoes the last move first and redoes in turn', () => {
    const history = createMoveHistory()
    history.record(one)
    history.record(two)
    expect(history.undo()).toBe(two)
    expect(history.undo()).toBe(one)
    expect(history.undo()).toBeUndefined()
    expect(history.redo()).toBe(one)
    expect(history.redo()).toBe(two)
    expect(history.redo()).toBeUndefined()
  })

  it('drops what could be redone once a new move is made, and records no empty move', () => {
    const history = createMoveHistory()
    history.record(one)
    history.undo()
    history.record([])
    expect(history.redo()).toBe(one)
    history.undo()
    history.record(two)
    expect(history.redo()).toBeUndefined()
    expect(history.undo()).toBe(two)
  })

  it('keeps at most the last moves it is given room for', () => {
    const history = createMoveHistory(2)
    history.record(one)
    history.record(two)
    history.record(one)
    expect(history.undo()).toBe(one)
    expect(history.undo()).toBe(two)
    expect(history.undo()).toBeUndefined()
  })

  it('forgets everything when cleared', () => {
    const history = createMoveHistory()
    history.record(one)
    history.clear()
    expect(history.undo()).toBeUndefined()
  })
})
