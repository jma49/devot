import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import {
  createIslandMounter,
  createIslandRegistry,
  drawingWidth,
  type IslandContent,
  type PreviewIsland,
} from './islands'

// The mounter only reads attributes, `isConnected` and `replaceChildren`, so
// plain objects stand in for the page's elements.
interface FakeElement {
  source: string
  top: number
  height: number
  /** The height it takes once a drawing is in it. */
  drawn: number
  style: { minHeight: string }
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
    height: 0,
    drawn: 200,
    style: { minHeight: '' },
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
    replaceChildren(this: FakeElement, ...nodes) {
      this.shown = nodes
      this.height = this.drawn
    },
    getBoundingClientRect(this: FakeElement) {
      const height = Math.max(this.height, Number.parseFloat(this.style.minHeight) || 0)
      return { top: this.top, bottom: this.top + height, height }
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

    it('tries a new failure at its own time, not after the long backoff already waiting', async () => {
      const { island, requests } = testIsland()
      const mounter = createIslandMounter(createIslandRegistry([island]))
      const a = islandElement('a')
      mounter.mount(hostOf([a]), { appearance: 'light' })
      for (const wait of [600, 1100]) {
        requests.at(-1)!.land({ retry: true })
        await vi.advanceTimersByTimeAsync(wait)
      }
      requests.at(-1)!.land({ retry: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(requests).toHaveLength(3)

      mounter.mount(hostOf([a, islandElement('b')]), { appearance: 'light' })
      expect(requests).toHaveLength(4)
      requests[3]!.land({ retry: true })
      await vi.advanceTimersByTimeAsync(600)
      expect(requests).toHaveLength(5)
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
    // A view 100 px high at the top of the window.
    function scroller(height = 100) {
      return {
        clientHeight: height,
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, bottom: height }),
      }
    }
    // What the page's IntersectionObserver would report: `near` says which
    // elements are now within its margin of the view.
    let observers: {
      callback: IntersectionObserverCallback
      options: IntersectionObserverInit | undefined
      targets: Set<unknown>
    }[] = []
    const near = (...elements: FakeElement[]) => report(elements, true)
    const far = (...elements: FakeElement[]) => report(elements, false)
    const report = (elements: FakeElement[], isIntersecting: boolean) => {
      for (const observer of observers) {
        const entries = elements
          .filter((el) => observer.targets.has(el))
          .map((target) => ({ target, isIntersecting }))
        if (entries.length > 0)
          observer.callback(
            entries as unknown as IntersectionObserverEntry[],
            {} as IntersectionObserver,
          )
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
      observers = []
      vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f))
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      )
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          private readonly entry
          constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
            this.entry = { callback, options, targets: new Set<unknown>() }
            observers.push(this.entry)
          }
          observe(el: unknown) {
            this.entry.targets.add(el)
          }
          unobserve(el: unknown) {
            this.entry.targets.delete(el)
          }
          disconnect() {
            this.entry.targets.clear()
          }
        },
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    const mounterFor = (island: PreviewIsland, view: ReturnType<typeof scroller>) =>
      createIslandMounter(createIslandRegistry([island]), {
        scroller: () => view as unknown as HTMLElement,
      })

    it('draws only the islands within a screen of the view, above or below it, the rest once scrolled near', () => {
      const { island, requests } = testIsland()
      const view = scroller()
      const mounter = mounterFor(island, view)
      const farAbove = islandElement('far above')
      const inView = islandElement('in view')
      const farBelow = islandElement('far below')
      mounter.mount(hostOf([farAbove, inView, farBelow]), { appearance: 'light' })
      expect(observers).toHaveLength(1)
      expect(observers[0]!.options).toMatchObject({
        root: view,
        rootMargin: '100% 0px',
      })
      far(farAbove, farBelow)
      near(inView)
      expect(requests.map((r) => r.source)).toEqual(['in view'])

      near(farBelow)
      near(farAbove)
      expect(requests.map((r) => r.source)).toEqual(['in view', 'far below', 'far above'])
      mounter.dispose()
      expect(observers[0]!.targets.size).toBe(0)
    })

    it('draws an island already near the view again at once when its source changes', () => {
      const { island, requests } = testIsland()
      const mounter = mounterFor(island, scroller())
      const el = islandElement('first')
      const host = hostOf([el])
      mounter.mount(host, { appearance: 'light' })
      near(el)
      el.source = 'second'
      mounter.mount(host, { appearance: 'light' })
      expect(requests.map((r) => r.source)).toEqual(['first', 'second'])
    })

    it('draws nothing while the view is hidden', () => {
      const { island, requests } = testIsland()
      const mounter = mounterFor(island, scroller(0))
      const el = islandElement('a')
      mounter.mount(hostOf([el]), { appearance: 'light' })
      near(el)
      expect(requests).toHaveLength(0)
    })

    it('draws a waiting island for its newest source only', () => {
      const { island, requests } = testIsland()
      const mounter = mounterFor(island, scroller())
      const el = islandElement('a')
      const host = hostOf([el])
      mounter.mount(host, { appearance: 'light' })
      el.source = 'b'
      mounter.mount(host, { appearance: 'dark' })
      near(el)
      expect(requests.map((r) => r.source)).toEqual(['b'])
    })

    it('puts the drawings that land together in place in one frame, and tells once', async () => {
      const { island, requests } = testIsland()
      const mounter = createIslandMounter(createIslandRegistry([island]), {
        scroller: () => scroller() as unknown as HTMLElement,
      })
      const elements = ['a', 'b', 'c'].map((source) => islandElement(source))
      const rendered = vi.fn<() => void>()
      mounter.mount(hostOf(elements), { appearance: 'light' }, rendered)
      near(...elements)
      requests.forEach((r) => r.land())
      await settle()
      expect(elements.map((el) => el.shown)).toEqual([[], [], []])
      expect(rendered).not.toHaveBeenCalled()

      nextFrame()
      expect(elements.map((el) => el.shown)).toEqual([
        [{ source: 'a' }],
        [{ source: 'b' }],
        [{ source: 'c' }],
      ])
      expect(rendered).toHaveBeenCalledTimes(1)
    })

    it('drops a drawing that lands after its source changed, before its frame', async () => {
      const { island, requests, live } = testIsland()
      const mounter = mounterFor(island, scroller())
      const el = islandElement('old')
      const host = hostOf([el])
      mounter.mount(host, { appearance: 'light' })
      near(el)
      requests[0]!.land()
      await settle()
      el.source = 'new'
      mounter.mount(host, { appearance: 'light' })
      nextFrame()
      expect(el.shown).toEqual([])
      expect(live()).toBe(0)
      requests[1]!.land()
      await settle()
      nextFrame()
      expect(el.shown).toEqual([{ source: 'new' }])
      mounter.dispose()
      expect(live()).toBe(0)
    })

    it('keeps what is in view still when a drawing above it lands', async () => {
      const { island, requests } = testIsland()
      const view = scroller()
      view.scrollTop = 1000
      const mounter = mounterFor(island, view)
      const above = Object.assign(islandElement('above'), { top: -300, height: 100, drawn: 260 })
      const below = Object.assign(islandElement('below'), { top: 50, height: 100, drawn: 400 })
      mounter.mount(hostOf([above, below]), { appearance: 'light' })
      near(above, below)
      requests.forEach((r) => r.land())
      await settle()
      nextFrame()
      // Only the one above the view moves what is shown; it grew by 160.
      expect(view.scrollTop).toBe(1160)
    })

    it('reserves the height a source was last drawn at while it is drawn again', async () => {
      const { island, requests } = testIsland()
      const mounter = mounterFor(island, scroller())
      const first = Object.assign(islandElement('remembered tall'), { drawn: 333 })
      mounter.mount(hostOf([first]), { appearance: 'light' })
      near(first)
      requests[0]!.land()
      await settle()
      nextFrame()
      expect(first.style.minHeight).toBe('')

      // The patcher made a new element for the same diagram.
      first.isConnected = false
      const again = islandElement('remembered tall')
      mounter.mount(hostOf([again]), { appearance: 'light' })
      expect(again.style.minHeight).toBe('333px')
      near(again)
      requests[1]!.land()
      await settle()
      nextFrame()
      expect(again.style.minHeight).toBe('')

      const unknown = islandElement('never drawn')
      mounter.mount(hostOf([again, unknown]), { appearance: 'light' })
      expect(unknown.style.minHeight).toBe('')
    })
  })
})

describe('the width an island draws for', () => {
  it('rounds down to a step, so the drawing fits and a drag draws seldom', () => {
    expect(drawingWidth(419)).toBe(400)
    expect(drawingWidth(400)).toBe(400)
  })

  it('has a floor: a chart narrower than that would hold nothing', () => {
    expect(drawingWidth(200)).toBe(320)
  })

  it('has no answer for an element without a width', () => {
    expect(drawingWidth(0)).toBeUndefined()
  })
})
