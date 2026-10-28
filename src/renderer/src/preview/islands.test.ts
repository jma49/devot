import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import {
  createIslandMounter,
  createIslandRegistry,
  type IslandContent,
  type PreviewIsland,
} from './islands'

// The mounter only reads attributes, `isConnected` and `replaceChildren`, so
// plain objects stand in for the page's elements.
interface FakeElement {
  source: string
  top: number
  isConnected: boolean
  /** Whether it still carries the attribute that makes it an island. */
  island: boolean
  shown: unknown[]
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  replaceChildren(...nodes: unknown[]): void
}

function islandElement(source: string): FakeElement {
  return {
    source,
    top: 0,
    isConnected: true,
    island: true,
    shown: [],
    hasAttribute(this: FakeElement, name) {
      return name === 'data-devot-island' && this.island
    },
    getAttribute(name) {
      if (name === 'data-devot-island') return 'test'
      if (name === 'data-island-source') return this.source
      return null
    },
    replaceChildren(...nodes) {
      this.shown = nodes
    },
    getBoundingClientRect(this: FakeElement) {
      return { top: this.top }
    },
  } as FakeElement
}

function hostOf(elements: FakeElement[]): Element {
  return { querySelectorAll: () => elements.filter((el) => el.isConnected) } as unknown as Element
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function testIsland() {
  const requests: {
    source: string
    signal: AbortSignal | undefined
    land: (content?: Partial<IslandContent>) => void
  }[] = []
  let live = 0
  const island: PreviewIsland = {
    kind: 'test',
    apiVersion: PREVIEW_API_VERSION,
    render(source, { signal }) {
      const gate = deferred<IslandContent>()
      requests.push({
        source,
        signal,
        land: (extra = {}) => {
          // Like Mermaid: the sheet is taken when the drawing arrives.
          live += 1
          let freed = false
          gate.resolve({
            node: { source } as unknown as Node,
            dispose: () => {
              if (freed) throw new Error('disposed twice')
              freed = true
              live -= 1
            },
            ...extra,
          })
        },
      })
      return gate.promise
    },
  }
  return { island, requests, live: () => live }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createIslandMounter', () => {
  it('releases the shown drawing when a newer one lands after quick re-requests', async () => {
    const { island, requests, live } = testIsland()
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const el = islandElement('a')
    const host = hostOf([el])

    mounter.mount(host, { appearance: 'light' })
    requests[0]!.land()
    await settle()
    expect(live()).toBe(1)

    // Two more requests while the first of them is still on its way.
    el.source = 'b'
    mounter.mount(host, { appearance: 'light' })
    el.source = 'c'
    mounter.mount(host, { appearance: 'light' })
    requests[1]!.land()
    requests[2]!.land()
    await settle()

    expect(el.shown).toEqual([{ source: 'c' }])
    expect(live()).toBe(1)
  })

  it('aborts a render once a newer one for its element starts, or the mounter goes', () => {
    const { island, requests } = testIsland()
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const el = islandElement('a')
    const host = hostOf([el])

    mounter.mount(host, { appearance: 'light' })
    el.source = 'b'
    mounter.mount(host, { appearance: 'light' })
    expect(requests.map((r) => r.signal?.aborted)).toEqual([true, false])

    mounter.dispose()
    expect(requests[1]!.signal?.aborted).toBe(true)
  })

  it('releases every sheet when it is disposed, including drawings still on their way', async () => {
    const { island, requests, live } = testIsland()
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const shown = islandElement('a')
    const waiting = islandElement('b')
    mounter.mount(hostOf([shown, waiting]), { appearance: 'light' })
    requests[0]!.land()
    await settle()
    expect(live()).toBe(1)

    mounter.dispose()
    expect(live()).toBe(0)
    requests[1]!.land()
    await settle()
    expect(live()).toBe(0)
    expect(waiting.shown).toEqual([])
  })

  it('releases the drawing of an island that left the page', async () => {
    const { island, requests, live } = testIsland()
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const el = islandElement('a')
    mounter.mount(hostOf([el]), { appearance: 'light' })
    requests[0]!.land()
    await settle()
    el.isConnected = false
    mounter.mount(hostOf([el]), { appearance: 'light' })
    expect(live()).toBe(0)
  })

  it('releases the drawing of an element that is no island any more', async () => {
    const { island, requests, live } = testIsland()
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const el = islandElement('a')
    mounter.mount(hostOf([el]), { appearance: 'light' })
    requests[0]!.land()
    await settle()
    expect(live()).toBe(1)
    // The patcher turned the diagram's div into a plain one, and later back.
    el.island = false
    mounter.mount(hostOf([]), { appearance: 'light' })
    expect(live()).toBe(0)
    el.island = true
    mounter.mount(hostOf([el]), { appearance: 'light' })
    expect(requests).toHaveLength(2)
  })

  describe('after a failure that may pass', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('waits out a backoff, then draws again without another patch, and keeps a final answer', async () => {
      const { island, requests } = testIsland()
      const mounter = createIslandMounter(createIslandRegistry([island]))
      const el = islandElement('a')
      const host = hostOf([el])

      mounter.mount(host, { appearance: 'light' })
      requests[0]!.land({ retry: true })
      await vi.advanceTimersByTimeAsync(0)
      // A patch right after does not ask again.
      mounter.mount(host, { appearance: 'light' })
      expect(requests).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(600)
      expect(requests).toHaveLength(2)
      requests[1]!.land({ retry: true })
      await vi.advanceTimersByTimeAsync(0)
      // Each failure waits longer than the one before.
      await vi.advanceTimersByTimeAsync(600)
      expect(requests).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(600)
      expect(requests).toHaveLength(3)

      requests[2]!.land()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)
      mounter.mount(host, { appearance: 'light' })
      expect(requests).toHaveLength(3)
      mounter.dispose()
    })

    it('starts over at once when the source changes', async () => {
      const { island, requests } = testIsland()
      const mounter = createIslandMounter(createIslandRegistry([island]))
      const el = islandElement('a')
      const host = hostOf([el])
      mounter.mount(host, { appearance: 'light' })
      requests[0]!.land({ retry: true })
      await vi.advanceTimersByTimeAsync(0)
      el.source = 'b'
      mounter.mount(host, { appearance: 'light' })
      expect(requests).toHaveLength(2)
      mounter.dispose()
    })
  })

  it('does not draw again at once after the island failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const island: PreviewIsland = {
      kind: 'test',
      apiVersion: PREVIEW_API_VERSION,
      render() {
        calls += 1
        return Promise.reject(new Error('E_TEST'))
      },
    }
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const host = hostOf([islandElement('a')])
    mounter.mount(host, { appearance: 'light' })
    await settle()
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledWith('W_PREVIEW_ISLAND_FAILED', 'test')
    mounter.dispose()
    warn.mockRestore()
  })

  describe('with a scroller', () => {
    // A view 100 px high at the top of the window: islands start above 200.
    function scroller(height = 100) {
      const listeners = new Map<string, () => void>()
      return {
        clientHeight: height,
        getBoundingClientRect: () => ({ bottom: height }),
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
        scroll: () => listeners.get('scroll')?.(),
        listeners,
      }
    }
    let frames: (() => void)[] = []
    const nextFrame = () => {
      const run = frames
      frames = []
      run.forEach((f) => f())
    }
    beforeEach(() => {
      frames = []
      vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f))
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    const mounterFor = (island: PreviewIsland, view: ReturnType<typeof scroller>) =>
      createIslandMounter(createIslandRegistry([island]), {
        scroller: () => view as unknown as HTMLElement,
      })

    it('draws islands above the view and up to a screen below it, the rest when scrolled near', () => {
      const { island, requests } = testIsland()
      const view = scroller()
      const mounter = mounterFor(island, view)
      const above = Object.assign(islandElement('above'), { top: -500 })
      const near = Object.assign(islandElement('near'), { top: 150 })
      const far = Object.assign(islandElement('far'), { top: 900 })
      mounter.mount(hostOf([above, near, far]), { appearance: 'light' })
      expect(requests).toHaveLength(0)
      nextFrame()
      expect(requests.map((r) => r.source)).toEqual(['above', 'near'])

      far.top = 180
      view.scroll()
      nextFrame()
      expect(requests.map((r) => r.source)).toEqual(['above', 'near', 'far'])
      mounter.dispose()
      expect(view.listeners.size).toBe(0)
    })

    it('draws nothing while the view is hidden', () => {
      const { island, requests } = testIsland()
      const mounter = mounterFor(island, scroller(0))
      mounter.mount(hostOf([islandElement('a')]), { appearance: 'light' })
      nextFrame()
      expect(requests).toHaveLength(0)
    })

    it('draws a waiting island for its newest source only', () => {
      const { island, requests } = testIsland()
      const view = scroller()
      const mounter = mounterFor(island, view)
      const el = Object.assign(islandElement('a'), { top: 900 })
      const host = hostOf([el])
      mounter.mount(host, { appearance: 'light' })
      el.source = 'b'
      mounter.mount(host, { appearance: 'dark' })
      el.top = 0
      nextFrame()
      expect(requests.map((r) => r.source)).toEqual(['b'])
    })
  })
})
