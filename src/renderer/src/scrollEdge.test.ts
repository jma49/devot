// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { isScrolled, scrolledBy, scrollEdges, showScrolledBy } from './scrollEdge'

it('fades only after moving below the top, including fractional scrolling', () => {
  for (const top of [0, -1, -20, NaN]) expect(isScrolled(top)).toBe(false)
  for (const top of [0.1, 1, 4, 28, 500]) expect(isScrolled(top)).toBe(true)
})

it('gives the fade the depth scrolled, so text below the top keeps its colour', () => {
  expect([0, -3, NaN, 6, 0.5, 27.25].map(scrolledBy)).toEqual([
    '0px',
    '0px',
    '0px',
    '6px',
    '0.5px',
    '27.25px',
  ])
})

it('stops at the fade depth, so scrolling further gives the same value', () => {
  expect([28, 28.5, 120, 50_000, Infinity].map(scrolledBy)).toEqual([
    '28px',
    '28px',
    '28px',
    '28px',
    '0px',
  ])
})

it('writes the depth on the pane only when it changes', () => {
  const pane = document.createElement('div')
  const write = vi.spyOn(pane.style, 'setProperty')
  for (const top of [0, 0, 6, 6, 30, 200, 4_000]) showScrolledBy(pane, top)
  expect(write.mock.calls).toEqual([
    ['--scrolled-by', '0px'],
    ['--scrolled-by', '6px'],
    ['--scrolled-by', '28px'],
  ])
  expect(pane.style.getPropertyValue('--scrolled-by')).toBe('28px')
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
