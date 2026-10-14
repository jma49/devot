import { describe, expect, it } from 'vitest'
import { DRAG_CARD_TITLES, dragCardLines } from './listDrag'

describe('the drag card', () => {
  it('lists up to four titles, one per line', () => {
    expect(DRAG_CARD_TITLES).toBe(4)
    expect(dragCardLines(['A'], 'en')).toEqual(['A'])
    expect(dragCardLines(['A', 'B', 'C', 'D'], 'en')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('shows only the count for more than four notes', () => {
    expect(dragCardLines(['A', 'B', 'C', 'D', 'E'], 'en')).toEqual(['5 notes'])
  })

  it('shows nothing for no notes', () => {
    expect(dragCardLines([], 'en')).toEqual([])
  })
})
