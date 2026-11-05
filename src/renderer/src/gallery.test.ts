import { describe, expect, it } from 'vitest'
import {
  galleryColumns,
  galleryGridTop,
  galleryPlace,
  galleryReveal,
  galleryScale,
  galleryStep,
  galleryWindow,
} from './gallery'
import { sizes } from './theme/tokens'
import { expectWithinBudget } from '../../../tests/support/budget'

const px = (name: keyof typeof sizes) => Number.parseFloat(sizes[name])

describe('galleryScale', () => {
  it('fits the page inside the cell and the sheet padding', () => {
    const inset = 2 * px('space.2') + 2 * px('space.4')
    expect(galleryScale(206, inset, px('size.gallery-page-width'))).toBeCloseTo(182 / 400)
  })

  it('is nothing for a card not measured yet or too narrow for its padding', () => {
    expect(galleryScale(0, 24, 400)).toBe(0)
    expect(galleryScale(20, 24, 400)).toBe(0)
  })
})

describe('galleryColumns', () => {
  it('fits as many cards as their least width allows, at least one', () => {
    expect(galleryColumns(1000, 180, 12)).toBe(5)
    expect(galleryColumns(563, 180, 12)).toBe(2)
    expect(galleryColumns(564, 180, 12)).toBe(3)
    expect(galleryColumns(100, 180, 12)).toBe(1)
    expect(galleryColumns(0, 180, 12)).toBe(1)
  })

  it('puts about four across at the wide pane’s default width', () => {
    // `.gallery-grid` in app.css: space-6 at each side, space-5 between cards.
    const inner = px('size.board-default-width') - 2 * px('space.6')
    expect(galleryColumns(inner, px('size.gallery-card-min-width'), px('space.5'))).toBe(4)
  })
})

describe('galleryStep', () => {
  // 10 cards in rows of 4: 0-3, 4-7, 8-9.
  const step = (at: number, key: string) => galleryStep(at, 10, 4, key)

  it('moves one card sideways, stopping at the ends', () => {
    expect(step(1, 'ArrowRight')).toBe(2)
    expect(step(3, 'ArrowRight')).toBe(4)
    expect(step(9, 'ArrowRight')).toBeUndefined()
    expect(step(4, 'ArrowLeft')).toBe(3)
    expect(step(0, 'ArrowLeft')).toBeUndefined()
  })

  it('moves a row up and down in the same column', () => {
    expect(step(1, 'ArrowDown')).toBe(5)
    expect(step(5, 'ArrowUp')).toBe(1)
    expect(step(2, 'ArrowUp')).toBeUndefined()
    expect(step(8, 'ArrowDown')).toBeUndefined()
  })

  it('goes down to the last card when the row below is shorter', () => {
    expect(step(6, 'ArrowDown')).toBe(9)
    expect(step(7, 'ArrowDown')).toBe(9)
  })

  it('ignores other keys and empty galleries', () => {
    expect(step(1, 'Enter')).toBeUndefined()
    expect(galleryStep(0, 0, 4, 'ArrowDown')).toBeUndefined()
  })

  it('reads right to left as the arrows point, in a right-to-left layout', () => {
    expect(galleryStep(1, 10, 4, 'ArrowRight', true)).toBe(0)
    expect(galleryStep(1, 10, 4, 'ArrowLeft', true)).toBe(2)
  })
})

describe('galleryPlace', () => {
  it('gives each card its row and column', () => {
    expect(galleryPlace(0, 4)).toEqual({ row: 0, column: 0 })
    expect(galleryPlace(9, 4)).toEqual({ row: 2, column: 1 })
  })
})

describe('galleryGridTop', () => {
  it('measures the grid from the top of the scrolled content, not from the page', () => {
    // A header of 60 above the scroller, the grid 16 into it, scrolled by 500.
    expect(galleryGridTop({ top: 60, scrollTop: 500, clientTop: 0 }, { top: 60 + 16 - 500 })).toBe(
      16,
    )
    expect(galleryGridTop({ top: 60, scrollTop: 0, clientTop: 1 }, { top: 77 })).toBe(16)
  })
})

describe('galleryReveal', () => {
  const view = { gridTop: 16, scrollTop: 900, height: 400 }
  it('scrolls back to the very top for a card of the first row', () => {
    expect(galleryReveal(0, 3, 210, 200, view)).toBe(0)
    expect(galleryReveal(2, 3, 210, 200, view)).toBe(0)
  })

  it('scrolls up to a card above the view', () => {
    expect(galleryReveal(4, 3, 210, 200, view)).toBe(16 + 210)
  })

  it('scrolls down just far enough to show a card below the view', () => {
    expect(galleryReveal(18, 3, 210, 200, view)).toBe(16 + 6 * 210 + 200 - 400)
  })

  it('leaves the scroll alone for a card in view', () => {
    expect(galleryReveal(15, 3, 210, 200, view)).toBe(900)
  })
})

describe('galleryWindow', () => {
  const rowStep = 250

  it('renders the rows that show and some around them', () => {
    const shown = galleryWindow(10_000, 4, rowStep, { top: 2500, height: 750 }, 250, [])
    expect(shown[0]).toBe(36)
    expect(shown.at(-1)).toBe(55)
    expect(shown).toHaveLength(20)
  })

  it('keeps the cards it is asked to, wherever they are', () => {
    const shown = galleryWindow(10_000, 4, rowStep, { top: 0, height: 500 }, 0, [9_999, 5_000])
    expect(shown).toContain(9_999)
    expect(shown).toContain(5_000)
    expect(shown).toEqual([...shown].sort((a, b) => a - b))
    expect(galleryWindow(10, 4, rowStep, null, 0, [42, -1])).not.toContain(42)
  })

  it('renders the first rows before anything is measured', () => {
    expect(galleryWindow(10_000, 4, rowStep, null, 0, [])).toHaveLength(32)
    expect(galleryWindow(5, 4, rowStep, null, 0, [])).toEqual([0, 1, 2, 3, 4])
  })

  it('works out the window of a long gallery in well under a frame', (context) => {
    const start = performance.now()
    for (let top = 0; top < 600_000; top += 600) {
      galleryWindow(10_000, 4, rowStep, { top, height: 900 }, 600, [0, 9_999])
    }
    // A thousand scroll positions in the time of a few frames.
    expectWithinBudget(context, performance.now() - start, 50)
  })
})
