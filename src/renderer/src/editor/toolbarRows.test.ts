import { describe, expect, it } from 'vitest'
import { breaksBefore, planRows } from './toolbarRows'

// The selection toolbar's groups at 28 px a button and 13 px a separator: 6, 2, 5 and 1 buttons.
const SEPARATOR = 13
const WITH_AI = [168, 56, 140, 28]
const WITHOUT_AI = [168, 56, 140]

describe('planRows', () => {
  it('keeps one row while every group fits', () => {
    expect(planRows(WITH_AI, SEPARATOR, 431)).toEqual({ rows: [4], width: 431 })
    expect(planRows(WITH_AI, SEPARATOR, 900)).toEqual({ rows: [4], width: 431 })
  })

  it('splits in two at the pair of cuts that makes the rows most alike, not one long row and a stub', () => {
    expect(planRows(WITH_AI, SEPARATOR, 430)).toEqual({ rows: [2, 2], width: 237 })
    expect(planRows(WITH_AI, SEPARATOR, 237)).toEqual({ rows: [2, 2], width: 237 })
  })

  it('uses a third row when two do not fit, and a fourth when three do not', () => {
    expect(planRows(WITH_AI, SEPARATOR, 236)).toEqual({ rows: [1, 1, 2], width: 181 })
    expect(planRows(WITH_AI, SEPARATOR, 181)).toEqual({ rows: [1, 1, 2], width: 181 })
    expect(planRows(WITH_AI, SEPARATOR, 180)).toEqual({ rows: [1, 1, 1, 1], width: 168 })
  })

  it('plans the toolbar without its AI button', () => {
    expect(planRows(WITHOUT_AI, SEPARATOR, 390)).toEqual({ rows: [3], width: 390 })
    expect(planRows(WITHOUT_AI, SEPARATOR, 389)).toEqual({ rows: [1, 2], width: 209 })
  })

  it('balances rows when several cuts fit', () => {
    expect(planRows([100, 100, 100, 100], 10, 250)).toEqual({ rows: [2, 2], width: 210 })
    expect(planRows([100, 100, 100, 100, 100], 10, 330)).toEqual({ rows: [3, 2], width: 320 })
  })

  it('never splits a group: a room narrower than the widest group sets one group to a row at the room', () => {
    expect(planRows(WITH_AI, SEPARATOR, 100)).toEqual({ rows: [1, 1, 1, 1], width: 100 })
    expect(planRows(WITH_AI, SEPARATOR, 0)).toEqual({ rows: [1, 1, 1, 1], width: 0 })
  })

  it('has no rows for no groups', () => {
    expect(planRows([], SEPARATOR, 300)).toEqual({ rows: [], width: 0 })
  })
})

describe('breaksBefore', () => {
  it('lists the groups that start a row after the first', () => {
    expect(breaksBefore([4])).toEqual(new Set())
    expect(breaksBefore([2, 2])).toEqual(new Set([2]))
    expect(breaksBefore([1, 1, 2])).toEqual(new Set([1, 2]))
    expect(breaksBefore([])).toEqual(new Set())
  })
})
