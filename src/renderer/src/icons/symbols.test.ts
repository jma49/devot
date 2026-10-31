import { describe, expect, it, vi } from 'vitest'
import symbolsJson from '../../../../design/icons/symbols.json'
import {
  boxPoints,
  createSymbolCache,
  ICONS,
  inkBounds,
  placeInCanvas,
  renderPoints,
  symbolFor,
  symbolStyle,
  type RenderSymbol,
} from './symbols'

const ok = (name: string, size: number) => Promise.resolve(`${name}@${size}`)

describe('symbol cache', () => {
  it('renders each name, size and appearance once', async () => {
    const render = vi.fn<RenderSymbol>(ok)
    const cache = createSymbolCache(render)
    const [a, b] = await Promise.all([cache.get('pin', 17, 'light'), cache.get('pin', 17, 'light')])
    expect(a).toBe('data:image/png;base64,pin@17')
    expect(b).toBe(a)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('renders each weight apart and passes it on, regular by default', async () => {
    const render = vi.fn<RenderSymbol>(ok)
    const cache = createSymbolCache(render)
    await cache.get('pin', 17, 'light')
    await cache.get('pin', 17, 'light', 'light')
    await cache.get('pin', 17, 'light', 'regular')
    expect(render.mock.calls.map((c) => c[2])).toEqual(['regular', 'light'])
  })

  it('renders again for another size or appearance', async () => {
    const render = vi.fn<RenderSymbol>(ok)
    const cache = createSymbolCache(render)
    await cache.get('pin', 17, 'light')
    await cache.get('pin', 14, 'light')
    await cache.get('pin', 17, 'dark')
    expect(render).toHaveBeenCalledTimes(3)
  })

  it('forgets a failed render so a later request retries', async () => {
    const render = vi
      .fn<RenderSymbol>()
      .mockRejectedValueOnce(new Error('E_SYMBOL_UNAVAILABLE'))
      .mockImplementation(ok)
    const cache = createSymbolCache(render)
    await expect(cache.get('pin', 17, 'light')).rejects.toThrow('E_SYMBOL_UNAVAILABLE')
    await expect(cache.get('pin', 17, 'light')).resolves.toBe('data:image/png;base64,pin@17')
  })
})

describe('icon names', () => {
  it('map to the SF Symbols listed in design/icons/symbols.json', () => {
    for (const icon of ICONS) {
      expect(symbolFor(icon)).toBe(symbolsJson.symbols[icon])
    }
  })
})

describe('ink', () => {
  it('is the bounds of the pixels more than a quarter opaque, in pixels', () => {
    // 4 by 3 pixels, RGBA: ink from (1, 0) to (2, 2); a faint pixel at (3, 2) does not count.
    const alpha = [0, 255, 0, 0, 0, 200, 255, 0, 0, 0, 255, 40]
    const rgba = alpha.flatMap((a) => [0, 0, 0, a])
    expect(inkBounds(rgba, 4, 3)).toEqual({ x: 1, y: 0, width: 2, height: 3 })
    expect(inkBounds([0, 0, 0, 10, 0, 0, 0, 64], 2, 1)).toBeNull()
  })
})

// Toolbar symbols as AppKit renders them at 36 pixels (18 points at two pixels a point): PNG
// width and height, then the ink's bounds.
const TOOLBAR = {
  'sidebar.left': [51, 39, { x: 4, y: 3, width: 42, height: 33 }],
  'book.closed': [39, 44, { x: 4, y: 3, width: 30, height: 38 }],
  'square.and.pencil': [45, 44, { x: 6, y: 6, width: 35, height: 35 }],
  'arrow.up.left.and.arrow.down.right': [43, 40, { x: 4, y: 3, width: 34, height: 34 }],
  'arrow.left': [42, 33, { x: 4, y: 3, width: 33, height: 27 }],
  ellipsis: [39, 13, { x: 3, y: 3, width: 33, height: 7 }],
} as const

describe('the point size of a box', () => {
  it('is the same for every symbol of the box, at any pixel ratio', () => {
    expect(boxPoints(22)).toBe(18)
    expect(boxPoints(17)).toBe(14)
    expect(renderPoints(14, 2)).toBe(14)
    expect(renderPoints(14, 3)).toBe(21)
    expect(renderPoints(14, 1)).toBe(7)
  })
})

describe('placing a symbol on its canvas', () => {
  it('centres its ink on whole device pixels, drawn at its own size, at any pixel ratio', () => {
    for (const ratio of [1, 2, 3])
      for (const [width, height, ink] of Object.values(TOOLBAR)) {
        const boxSide = 22 * ratio
        const at = placeInCanvas(width, height, ink, 22, ratio)
        for (const n of Object.values(at)) expect(Number.isInteger(n)).toBe(true)
        expect(Math.abs(at.x + ink.x + ink.width / 2 - at.side / 2)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(at.y + ink.y + ink.height / 2 - at.side / 2)).toBeLessThanOrEqual(0.5)
        // The whole PNG fits unscaled, and the canvas keeps the box's centre.
        expect(at.x).toBeGreaterThanOrEqual(0)
        expect(at.y).toBeGreaterThanOrEqual(0)
        expect(at.x + width).toBeLessThanOrEqual(at.side)
        expect(at.y + height).toBeLessThanOrEqual(at.side)
        expect(at.side).toBeGreaterThanOrEqual(boxSide)
        expect((at.side - boxSide) % 2).toBe(0)
      }
  })

  it('keeps the box for a symbol that fits, and grows it for a wider one rather than shrink it', () => {
    const [arrowWidth, arrowHeight, arrowInk] = TOOLBAR['arrow.left']
    expect(placeInCanvas(arrowWidth, arrowHeight, arrowInk, 22, 2)).toEqual({
      side: 44,
      x: 2,
      y: 6,
    })
    const [width, height, ink] = TOOLBAR['sidebar.left']
    expect(placeInCanvas(width, height, ink, 22, 2)).toEqual({ side: 54, x: 2, y: 8 })
  })
})

describe('a placed symbol in its box', () => {
  it('shows the canvas at its exact CSS size, mask size included, never scaled', () => {
    const style = symbolStyle({ url: 'data:x', side: 27 }, 22)
    expect(style.width).toBe('27px')
    expect(style.height).toBe('27px')
    expect(style.maskSize).toBe('27px 27px')
    expect(style.WebkitMaskSize).toBe('27px 27px')
    expect(JSON.stringify(style)).not.toMatch(/contain|%/)
  })

  it('overhangs the box evenly, keeping the box in the layout', () => {
    expect(symbolStyle({ url: 'data:x', side: 27 }, 22).margin).toBe('-2.5px')
    expect(symbolStyle({ url: 'data:x', side: 22 }, 22).margin).toBe('0px')
  })
})
