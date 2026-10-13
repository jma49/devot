import { describe, expect, it, vi } from 'vitest'
import symbolsJson from '../../../../design/icons/symbols.json'
import { createSymbolCache, ICONS, symbolFor, type RenderSymbol } from './symbols'

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
