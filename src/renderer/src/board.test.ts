import { describe, expect, it } from 'vitest'
import type { NoteStatus } from '../../core/storage'
import { sizes } from './theme/tokens'
import {
  appliedChanges,
  boardColumns,
  boardJump,
  boardOrder,
  boardStatuses,
  cardStep,
  changesByStatus,
  columnJump,
  columnWindow,
  createBoardHistories,
  createMoveHistory,
  moveChanges,
  redoChanges,
  statusStep,
  stepChanges,
  undoChanges,
  type BoardMove,
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
  const asIs = (move: BoardMove) => move

  it('undoes the last move first and redoes in turn', () => {
    const history = createMoveHistory()
    history.record(one)
    history.record(two)
    expect(history.undo(asIs)).toBe(two)
    expect(history.undo(asIs)).toBe(one)
    expect(history.undo(asIs)).toBeUndefined()
    expect(history.redo(asIs)).toBe(one)
    expect(history.redo(asIs)).toBe(two)
    expect(history.redo(asIs)).toBeUndefined()
  })

  it('gives what a move changes now, and passes over a move that changes nothing any more', () => {
    const history = createMoveHistory()
    history.record(one)
    history.record(two)
    const now = (move: BoardMove) => (move === two ? [] : undoChanges(move, [note('a', 'active')]))
    expect(history.undo(now)).toEqual([{ id: 'a', from: 'active', to: 'none' }])
    expect(history.undo(asIs)).toBeUndefined()
    expect(history.redo(asIs)).toBe(one)
    expect(history.redo(asIs)).toBeUndefined()
  })

  it('settles a move to what its write made, dropping it when nothing was', () => {
    const history = createMoveHistory()
    const both = [...one, ...two]
    history.record(both)
    history.record(two)
    history.settle(both, one)
    history.settle(two, [])
    expect(history.undo(asIs)).toEqual(one)
    expect(history.undo(asIs)).toBeUndefined()
    history.settle(one, [])
    expect(history.redo(asIs)).toBeUndefined()
  })

  it('drops what could be redone once a new move is made, and records no empty move', () => {
    const history = createMoveHistory()
    history.record(one)
    history.undo(asIs)
    history.record([])
    expect(history.redo(asIs)).toBe(one)
    history.undo(asIs)
    history.record(two)
    expect(history.redo(asIs)).toBeUndefined()
    expect(history.undo(asIs)).toBe(two)
  })

  it('keeps at most the last moves it is given room for', () => {
    const history = createMoveHistory(2)
    history.record(one)
    history.record(two)
    history.record(one)
    expect(history.undo(asIs)).toBe(one)
    expect(history.undo(asIs)).toBe(two)
    expect(history.undo(asIs)).toBeUndefined()
  })
})

describe('createBoardHistories', () => {
  const one = [{ id: 'a', from: 'none' as const, to: 'active' as const }]
  const asIs = (move: BoardMove) => move

  it('keeps a history per board, which another board leaves alone', () => {
    const boards = createBoardHistories()
    boards.forView('all').record(one)
    expect(boards.forView('book:x').undo(asIs)).toBeUndefined()
    expect(boards.forView('all').undo(asIs)).toBe(one)
  })

  it('forgets the board used longest ago once it holds more than it has room for', () => {
    const boards = createBoardHistories(2)
    boards.forView('a').record(one)
    boards.forView('b').record(one)
    boards.forView('a')
    boards.forView('c').record(one)
    expect(boards.forView('a').undo(asIs)).toBe(one)
    expect(boards.forView('b').undo(asIs)).toBeUndefined()
  })
})

describe('appliedChanges', () => {
  it('leaves out the notes whose write failed', () => {
    const move = [
      { id: 'a', from: 'none' as const, to: 'active' as const },
      { id: 'b', from: 'none' as const, to: 'active' as const },
    ]
    expect(appliedChanges(move, ['b'])).toEqual([move[0]])
    expect(appliedChanges(move, [])).toEqual(move)
  })
})

describe('columnWindow', () => {
  const ids = Array.from({ length: 3000 }, (_, i) => `n${i}`)
  const height = () => 60
  const count = (runs: [number, number][]) => runs.reduce((n, [a, b]) => n + b - a, 0)

  it('renders the cards that show and the overscan, however long the column', () => {
    const view = { top: 66 * 1000, height: 600 }
    const { runs, offsets } = columnWindow(ids, height, 6, view, new Set())
    expect(count(runs)).toBeLessThan(60)
    expect(runs[0]![0]).toBeLessThan(1000)
    expect(runs.at(-1)![1]).toBeGreaterThan(1010)
    expect(offsets[ids.length]).toBe(3000 * 66)
  })

  it('keeps each kept card and its neighbours, wherever they are', () => {
    const view = { top: 0, height: 600 }
    const { runs } = columnWindow(ids, height, 6, view, new Set(['n2500', 'gone']))
    expect(runs.at(-1)).toEqual([2498, 2503])
  })

  it('renders the first cards, to measure, before the column has been measured', () => {
    const { runs } = columnWindow(ids, height, 6, undefined, new Set(['n9']))
    expect(count(runs)).toBeLessThanOrEqual(40)
    expect(runs[0]![0]).toBe(0)
  })
})

describe('the default board width', () => {
  it('fits every column at its narrowest', () => {
    const px = (name: keyof typeof sizes) => parseFloat(sizes[name])
    const columns = boardStatuses(true).length
    // `.board-columns` in app.css: space-4 between columns, space-6 at each side.
    const needed =
      columns * px('size.board-column-min-width') +
      (columns - 1) * px('space.4') +
      2 * px('space.6')
    expect(px('size.board-default-width')).toBeGreaterThanOrEqual(needed)
  })
})

describe('columnJump', () => {
  it('pages from the column that has the keyboard, even an empty one', () => {
    const columns = boardColumns(notes, boardStatuses(true))
    expect(columnJump(columns, 'on_hold', 'PageDown')).toBe('d')
    expect(columnJump(columns, 'on_hold', 'PageUp')).toBe('a')
    expect(columnJump(columns, 'on_hold', 'Home')).toBe('b')
    expect(columnJump(columns, 'on_hold', 'End')).toBe('e')
    expect(columnJump(columns, 'dropped', 'PageDown')).toBeUndefined()
    expect(columnJump(columns, 'none', 'PageUp')).toBeUndefined()
    expect(columnJump(columns, 'none', 'ArrowDown')).toBeUndefined()
  })
})

describe('boardJump', () => {
  it('goes to the first or last card, or the first card of the column a page away', () => {
    const columns = boardColumns(notes, boardStatuses(true))
    expect(boardJump(columns, 'a', 'Home')).toBe('b')
    expect(boardJump(columns, 'a', 'End')).toBe('e')
    expect(boardJump(columns, 'a', 'PageDown')).toBe('d')
    expect(boardJump(columns, 'd', 'PageUp')).toBe('a')
    expect(boardJump(columns, 'e', 'PageDown')).toBeUndefined()
    expect(boardJump(columns, 'b', 'PageUp')).toBeUndefined()
    expect(boardJump(columns, 'a', 'ArrowDown')).toBeUndefined()
  })
})
