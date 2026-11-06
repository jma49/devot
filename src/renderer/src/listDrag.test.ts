import { describe, expect, it } from 'vitest'
import { DRAG_CARD_TITLES, dragCardBadge, dragCardLines } from './listDrag'

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

describe('the dragged board card’s badge', () => {
  it('counts the notes a drag of several carries', () => {
    expect(dragCardBadge(3, 'en')).toBe('3')
    expect(dragCardBadge(1200, 'en')).toBe('1,200')
  })

  it('is not shown for one note', () => {
    expect(dragCardBadge(1, 'en')).toBeUndefined()
    expect(dragCardBadge(0, 'en')).toBeUndefined()
  })
})
