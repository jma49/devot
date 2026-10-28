import { describe, expect, it } from 'vitest'
import {
  keyTarget,
  openAfter,
  selectAll,
  selectRange,
  selectStep,
  selectToggle,
  type ListSelection,
} from './listSelection'

const order = ['a', 'b', 'c', 'd', 'e']
const sel = (ids: string[], anchor: string, lead = anchor): ListSelection => ({ ids, anchor, lead })

describe('the note list selection', () => {
  it('Cmd-click adds a row next to the open note, and the row becomes the anchor', () => {
    expect(selectToggle(undefined, 'b', 'd', order)).toEqual(sel(['b', 'd'], 'd'))
    expect(selectToggle(sel(['b', 'd'], 'd'), 'b', 'a', order)).toEqual(sel(['a', 'b', 'd'], 'a'))
  })

  it('Cmd-click with no note open selects that row alone', () => {
    expect(selectToggle(undefined, undefined, 'c', order)).toEqual(sel(['c'], 'c'))
  })

  it('Cmd-click on a selected row takes it out; the anchor moves to a neighbour', () => {
    expect(selectToggle(sel(['a', 'b', 'd'], 'b'), 'a', 'b', order)).toEqual(sel(['a', 'd'], 'd'))
    expect(selectToggle(sel(['a', 'b', 'd'], 'd'), 'a', 'd', order)).toEqual(sel(['a', 'b'], 'b'))
    expect(selectToggle(sel(['a', 'b'], 'b'), 'a', 'a', order)).toEqual(sel(['b'], 'b'))
    expect(selectToggle(undefined, 'a', 'a', order)).toEqual(sel(['a'], 'a'))
  })

  it('Shift-click selects the rows from the anchor to the row, either way', () => {
    expect(selectRange(undefined, 'b', 'd', order)).toEqual(sel(['b', 'c', 'd'], 'b', 'd'))
    expect(selectRange(undefined, 'd', 'b', order)).toEqual(sel(['b', 'c', 'd'], 'd', 'b'))
    // A new range from the same anchor replaces the last one.
    expect(selectRange(sel(['b', 'c', 'd'], 'b', 'd'), 'b', 'a', order)).toEqual(
      sel(['a', 'b'], 'b', 'a'),
    )
    // No open note: the row alone.
    expect(selectRange(undefined, undefined, 'c', order)).toEqual(sel(['c'], 'c'))
  })

  it('Shift+Up and Shift+Down move the far end of the range', () => {
    let s = selectStep(undefined, 'b', 1, order)!
    expect(s).toEqual(sel(['b', 'c'], 'b', 'c'))
    s = selectStep(s, 'b', 1, order)!
    expect(s).toEqual(sel(['b', 'c', 'd'], 'b', 'd'))
    s = selectStep(s, 'b', -1, order)!
    expect(s).toEqual(sel(['b', 'c'], 'b', 'c'))
    s = selectStep(s, 'b', -1, order)!
    expect(s).toEqual(sel(['b'], 'b', 'b'))
    s = selectStep(s, 'b', -1, order)!
    expect(s).toEqual(sel(['a', 'b'], 'b', 'a'))
    expect(selectStep(s, 'b', -1, order)).toBeUndefined()
    expect(selectStep(undefined, undefined, 1, order)).toBeUndefined()
  })

  it('Select All takes every row and keeps the anchor', () => {
    expect(selectAll(undefined, 'c', order)).toEqual(sel(order, 'c'))
    expect(selectAll(sel(['b', 'd'], 'd'), 'b', order)).toEqual(sel(order, 'd'))
    expect(selectAll(undefined, undefined, order)).toEqual(sel(order, 'a'))
  })

  it('keeps the open note open while it is selected; else the anchor opens', () => {
    expect(openAfter(sel(['a', 'b'], 'b'), 'a')).toBe('a')
    expect(openAfter(sel(['b', 'c'], 'c'), 'a')).toBe('c')
    expect(openAfter(sel(['b', 'c'], 'c'), undefined)).toBe('c')
    expect(openAfter(sel(['b', 'c'], 'x', 'b'), 'a')).toBe('b')
  })

  it('starts again from a selected row when the anchor or lead is no longer listed', () => {
    // The lead (d) left the list: Shift+Down goes on from the anchor.
    expect(selectStep(sel(['b', 'c', 'd'], 'b', 'd'), 'b', 1, ['a', 'b', 'c', 'e'])).toEqual(
      sel(['b', 'c'], 'b', 'c'),
    )
    expect(selectRange(sel(['b', 'c'], 'x', 'x'), 'b', 'e', ['a', 'b', 'c', 'e'])).toEqual(
      sel(['b', 'c', 'e'], 'b', 'e'),
    )
  })

  it('keeps the selection in list order', () => {
    expect(selectToggle(sel(['b', 'd'], 'd'), 'b', 'c', order).ids).toEqual(['b', 'c', 'd'])
  })

  it('aims a key at the selection when a Cmd-click took the open note out of it', () => {
    // The open note is still a until its opening resolves; the selection is b and c.
    expect(keyTarget(sel(['b', 'c'], 'b'), 'a', 'a')).toBe('b')
    expect(keyTarget(sel(['b', 'c'], 'b'), 'c', 'c')).toBe('c')
    // No selection: the focused row.
    expect(keyTarget(undefined, 'a', 'c')).toBe('c')
    expect(keyTarget(sel(['b', 'c'], 'b'), undefined, 'c')).toBe('b')
  })
})
