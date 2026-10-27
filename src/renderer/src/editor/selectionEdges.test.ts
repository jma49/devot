import { describe, expect, it } from 'vitest'
import { edgeReach } from './selectionEdges'

describe('edgeReach', () => {
  it('reaches from a row edge out to the box, and nowhere otherwise', () => {
    expect(edgeReach(true, true, 20, 40, 10, 100)).toEqual({ start: 10, end: 60 })
    expect(edgeReach(true, false, 20, 40, 10, 100)).toEqual({ start: 10, end: 0 })
    expect(edgeReach(false, true, 20, 40, 10, 100)).toEqual({ start: 0, end: 60 })
    expect(edgeReach(false, false, 20, 40, 10, 100)).toEqual({ start: 0, end: 0 })
  })

  it('reaches nowhere without a measured edge, or past the fill', () => {
    expect(edgeReach(true, true, null, null, 10, 100)).toEqual({ start: 0, end: 0 })
    expect(edgeReach(true, true, 5, 120, 10, 100)).toEqual({ start: 0, end: 0 })
  })
})
