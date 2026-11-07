// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreLocalStorage, useMemoryLocalStorage } from '../../../../tests/support/local-storage'

const rendered = vi.hoisted(() => [] as unknown[])
vi.mock('../editorSettings', () => ({
  useEditorSetting: () => 'sfSymbols',
  editorSettings: () => ({ iconStyle: 'sfSymbols' }),
}))
vi.mock('../ipc', () => ({
  invoke: async (_command: string, args: unknown) => {
    rendered.push(args)
    return 'AAAA'
  },
}))

const KEPT = 'devot.placedSymbols'

class DecodedImage {
  src = ''
  naturalWidth = 8
  naturalHeight = 8
  decode = async () => {}
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A start of the window: the icon module loaded afresh, over the localStorage the last one left. */
async function launch() {
  vi.resetModules()
  rendered.length = 0
  return import('./Icon')
}

/** Waits until the icons are drawn, then as long as a launch takes to keep them. */
async function settle(spans: HTMLElement[]) {
  await vi.waitFor(() => expect(spans.every((s) => s.dataset['pending'] === undefined)).toBe(true))
  await vi.advanceTimersByTimeAsync(10_000)
}

beforeEach(() => {
  useMemoryLocalStorage()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubEnv('DEV', false)
  vi.stubGlobal('Image', DecodedImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,PLACED')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  restoreLocalStorage()
})

describe('symbol icons across launches', () => {
  it('draws on the second launch what the first placed, asking Rust for nothing', async () => {
    const first = await launch()
    await settle([first.iconElement('trash', 16), first.iconElement('nav.back', 22)])
    expect(rendered).toHaveLength(2)

    const second = await launch()
    const spans = [second.iconElement('trash', 16), second.iconElement('nav.back', 22)]
    await vi.waitFor(() =>
      expect(spans.every((s) => s.dataset['pending'] === undefined)).toBe(true),
    )
    expect(rendered).toEqual([])
    expect(spans[0]?.style.cssText).toContain('PLACED')
  })

  it('draws them again for another build', async () => {
    const first = await launch()
    await settle([first.iconElement('trash', 16)])
    const kept = JSON.parse(localStorage.getItem(KEPT)!) as { stamp: string }
    localStorage.setItem(KEPT, JSON.stringify({ ...kept, stamp: 'another build' }))

    const second = await launch()
    await settle([second.iconElement('trash', 16)])
    expect(rendered).toHaveLength(1)
  })

  it('keeps no symbol that was only preloaded, as the icon catalog does', async () => {
    const first = await launch()
    first.preloadSymbols(['star', 'heart'], 'lg')
    await vi.waitFor(() => expect(rendered).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(10_000)

    const second = await launch()
    second.preloadSymbols(['star', 'heart'], 'lg')
    await vi.waitFor(() => expect(rendered).toHaveLength(2))
  })

  it('shares one pixel-ratio query among every icon shown', async () => {
    const { SymbolIcon } = await launch()
    const queries = vi.spyOn(window, 'matchMedia')
    const root = createRoot(document.createElement('div'))
    act(() =>
      root.render(
        <>
          {['trash', 'star', 'heart', 'folder', 'tag'].map((symbol) => (
            <SymbolIcon key={symbol} symbol={symbol} size="md" />
          ))}
        </>,
      ),
    )
    const ratioQueries = queries.mock.calls.filter(([query]) => query.includes('resolution'))
    act(() => root.unmount())
    expect(ratioQueries).toHaveLength(1)
  })
})
