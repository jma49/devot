import { describe, expect, it } from 'vitest'
import { isScrolled, scrollEdges } from './scrollEdge'

it('fades only after moving below the top, including fractional scrolling', () => {
  for (const top of [0, -1, -20, NaN]) expect(isScrolled(top)).toBe(false)
  for (const top of [0.1, 1, 4, 28, 500]) expect(isScrolled(top)).toBe(true)
})

describe('scrollEdges', () => {
  const at = (scrollTop: number) => scrollEdges({ scrollTop, scrollHeight: 500, clientHeight: 200 })

  it('reports nothing when the content fits', () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 })).toEqual({
      above: false,
      below: false,
    })
  })

  it('reports only what lies beyond each edge', () => {
    expect(at(0)).toEqual({ above: false, below: true })
    expect(at(100)).toEqual({ above: true, below: true })
    expect(at(300)).toEqual({ above: true, below: false })
  })

  it('treats a fractional remainder at the end as the end', () => {
    expect(at(299.5)).toEqual({ above: true, below: false })
    expect(at(298)).toEqual({ above: true, below: true })
  })

  it('treats elastic overscroll as being at the edge it passed', () => {
    expect(at(-20)).toEqual({ above: false, below: true })
    expect(at(320)).toEqual({ above: true, below: false })
  })
})
