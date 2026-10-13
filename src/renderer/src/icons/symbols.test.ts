import { describe, expect, it, vi } from 'vitest'
import symbolsJson from '../../../../design/icons/symbols.json'
import {
  createSymbolCache,
  ICONS,
  symbolFor,
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

  it('keeps a symbol at its own size, centred on its box, overhanging it evenly', () => {
    const style = symbolStyle(png(50, 32), 18)
    expect(style).toMatchObject({ width: '25px', height: '16px', margin: '1px -3.5px' })
    expect(style['maskSize']).toBe('100% 100%')
  })

  it('falls back to the mask alone when the PNG cannot be read', () => {
    expect(symbolStyle('data:image/png;base64,pin@17', 18)).toEqual({
      maskImage: 'url("data:image/png;base64,pin@17")',
      WebkitMaskImage: 'url("data:image/png;base64,pin@17")',
    })
  })
})
