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
  it('caps actual ink at the box without counting transparent PNG padding', () => {
    for (const ratio of [1, 2, 3])
      for (const [, , ink] of Object.values(TOOLBAR)) {
        const at = placeInCanvas(ink, 22, ratio)
        expect(at.side).toBe(Math.round(22 * ratio))
        expect(at.scale).toBeLessThanOrEqual(1)
        expect(ink.width * at.scale).toBeLessThanOrEqual(at.side)
        expect(ink.height * at.scale).toBeLessThanOrEqual(at.side)
        expect(
          Math.abs(at.x + (ink.x + ink.width / 2) * at.scale - at.side / 2),
        ).toBeLessThanOrEqual(0.5)
        expect(
          Math.abs(at.y + (ink.y + ink.height / 2) * at.scale - at.side / 2),
        ).toBeLessThanOrEqual(0.5)
      }
  })

  it('preserves a fitting glyph and shrinks oversized ink rather than overhanging', () => {
    expect(placeInCanvas(TOOLBAR['sidebar.left'][2], 22, 2).scale).toBe(1)
    const oversized = { x: 30, y: 40, width: 60, height: 50 }
    expect(placeInCanvas(oversized, 22, 2).scale).toBeCloseTo(44 / 60)
    expect(placeInCanvas({ ...oversized, x: 300, y: 400 }, 22, 2).scale).toBeCloseTo(44 / 60)
  })

  it('fits a title glyph to cap height, including the wide Templates symbol', () => {
    for (const ink of [
      { x: 4, y: 3, width: 30, height: 38 },
      { x: 5, y: 6, width: 46, height: 39 },
      { x: 3, y: 3, width: 36, height: 36 },
    ]) {
      const at = placeInCanvas(ink, 17, 2, true)
      const caps = at.side / 1.4
      expect((ink.height * at.scale) / caps).toBeGreaterThanOrEqual(1)
      expect((ink.height * at.scale) / caps).toBeLessThanOrEqual(1.3)
      expect(ink.width * at.scale).toBeLessThanOrEqual(at.side)
    }
  })
})

describe('a placed symbol in its box', () => {
  it('uses the fixed box with no negative margins and scales its mask with text', () => {
    const style = symbolStyle({ url: 'data:x', side: 22 })
    expect(style.maskSize).toBe('100% 100%')
    expect(style.WebkitMaskSize).toBe('100% 100%')
    expect(style).not.toHaveProperty('margin')
    expect(style).not.toHaveProperty('width')
    expect(style).not.toHaveProperty('height')
  })
})
