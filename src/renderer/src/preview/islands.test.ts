import { describe, expect, it, vi } from 'vitest'
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
  isConnected: boolean
  shown: unknown[]
  getAttribute(name: string): string | null
  replaceChildren(...nodes: unknown[]): void
}

function islandElement(source: string): FakeElement {
  return {
    source,
    isConnected: true,
    shown: [],
    getAttribute(name) {
      if (name === 'data-devot-island') return 'test'
      if (name === 'data-island-source') return this.source
      return null
    },
    replaceChildren(...nodes) {
      this.shown = nodes
    },
  }
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
  const requests: { source: string; land: (content?: Partial<IslandContent>) => void }[] = []
  let live = 0
  const island: PreviewIsland = {
    kind: 'test',
    apiVersion: PREVIEW_API_VERSION,
    render(source) {
      const gate = deferred<IslandContent>()
      requests.push({
        source,
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

  it('draws again at the next mount only after a failure that may pass', async () => {
    const { island, requests } = testIsland()
    const mounter = createIslandMounter(createIslandRegistry([island]))
    const el = islandElement('a')
    const host = hostOf([el])

    mounter.mount(host, { appearance: 'light' })
    requests[0]!.land({ retry: true })
    await settle()
    mounter.mount(host, { appearance: 'light' })
    expect(requests).toHaveLength(2)

    // A final answer (a drawing, or an error in the source) is kept.
    requests[1]!.land()
    await settle()
    mounter.mount(host, { appearance: 'light' })
    expect(requests).toHaveLength(2)
  })

  it('draws again at the next mount after the island failed', async () => {
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
    mounter.mount(host, { appearance: 'light' })
    await settle()
    expect(calls).toBe(2)
    expect(warn).toHaveBeenCalledWith('W_PREVIEW_ISLAND_FAILED', 'test')
    warn.mockRestore()
  })
})
