import { describe, expect, it, vi } from 'vitest'
import symbolsJson from '../../../../design/icons/symbols.json'
import {
  createSymbolCache,
  evenPixels,
  ICONS,
  symbolFor,
  inkBounds,
  symbolSize,
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

/** A PNG's signature and header, `width` by `height` pixels, as a data URL. */
function png(width: number, height: number): string {
  const be = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const bytes = [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    ...be(width),
    ...be(height),
    8,
    6,
    0,
    0,
    0,
  ]
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
}

describe('symbol size', () => {
  it('is half the PNG, which Rust renders at twice the point size', () => {
    expect(symbolSize(png(50, 32))).toEqual({ width: 25, height: 16 })
    expect(symbolSize('data:image/png;base64,pin@17')).toBeNull()
  })
})

describe('ink', () => {
  it('is the bounds of the pixels more than a quarter opaque, in CSS pixels', () => {
    // 4 by 3 pixels: ink from (1, 0) to (2, 2); a faint pixel at (3, 2) does not count.
    const alpha = [0, 255, 0, 0, 0, 200, 255, 0, 0, 0, 255, 40]
    expect(inkBounds(alpha, 4, 3)).toEqual({
      x: 0.5,
      y: 0,
      width: 1,
      height: 1.5,
    })
    expect(inkBounds([0, 10, 64], 3, 1)).toBeNull()
  })
})

describe('even pixels', () => {
  it('grows an odd side by one pixel, so a CSS size is whole', () => {
    expect(evenPixels(31)).toBe(32)
    expect(evenPixels(32)).toBe(32)
  })
})

describe('placing a symbol in its box', () => {
  const image = {
    url: 'data:x',
    width: 20,
    height: 16,
    ink: { x: 1, y: 2, width: 17, height: 11 },
  }

  it('shows the PNG at its exact CSS size, mask size included, never scaled', () => {
    const style = symbolStyle(image, 18)
    expect(style.width).toBe('20px')
    expect(style.height).toBe('16px')
    expect(style.maskSize).toBe('20px 16px')
    expect(style.WebkitMaskSize).toBe('20px 16px')
    expect(JSON.stringify(style)).not.toMatch(/contain|%/)
  })

  it('centres the ink on the box on whole pixels, keeping the box in the layout', () => {
    // Ink centre (9.5, 7.5) onto (9, 9): left -0.5 rounds to 0 (-0 shown as 0), top 1.5 rounds to 2.
    for (const px of symbolStyle(image, 18).margin!.split(' '))
      expect(Number.isInteger(Number.parseFloat(px))).toBe(true)
    expect(symbolStyle(image, 18).margin).toBe('2px -2px 0px 0px')
  })
})
