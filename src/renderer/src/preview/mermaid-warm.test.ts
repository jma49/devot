// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"disableIframePageLoading":false}}
import { afterEach, expect, it, vi } from 'vitest'
import { hasCachedMermaid, mermaidIsland, warmMermaid } from './mermaid'
import { READY } from './mermaid-protocol'
import { FRAME_IDLE_MS } from './frameLifetime'

const cache = vi.hoisted(() => {
  const keys = new Set<string>()
  const lookup = (key: string | ((key: string) => boolean)) =>
    typeof key === 'string' ? keys.has(key) : [...keys].some(key)
  return {
    keys,
    lookup,
    has: vi.fn<typeof lookup>(lookup),
    answer: vi.fn<(key: string) => Promise<unknown>>(async (key) => {
      keys.add(key)
      return {
        type: 'rendered',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0L20 20"/></svg>',
      }
    }),
  }
})
vi.mock('./kept', () => ({ keptAnswers: () => Object.assign(cache.answer, { has: cache.has }) }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cache.keys.clear()
  cache.has.mockImplementation(cache.lookup)
  document.body.replaceChildren()
})

it('warms the engine through the private frame port without rendering a diagram and releases the frame', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLIFrameElement,
    value,
  ) {
    this.setAttribute('data-test-src', value)
  })
  const sent: unknown[] = []
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { postMessage: (message: unknown) => sent.push(message), close() {}, onmessage: null }
      port2 = {}
    },
  )
  const release = warmMermaid('```mermaid\nflowchart LR\nA-->B\n```', { appearance: 'light' })
  const frame = document.querySelector('iframe')!
  expect(frame.getAttribute('data-test-src')).toContain('mermaid.html')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  window.dispatchEvent(
    new MessageEvent('message', { data: READY, origin: 'null', source: frame.contentWindow }),
  )
  await Promise.resolve()
  expect(sent).toEqual([{ type: 'warm', kind: 'mermaid' }])
  release()
  release()
  await vi.advanceTimersByTimeAsync(FRAME_IDLE_MS)
  expect(document.querySelector('iframe')).toBeNull()
})

it.each(['', 'A plain note', '```ts\n```mermaid\nflowchart LR\n```\n```'])(
  'does not warm for a note without a Mermaid fence: %s',
  (markdown) => {
    warmMermaid(markdown, { appearance: 'light' })()
    expect(document.querySelector('iframe')).toBeNull()
  },
)

it('recognizes a cached first Mermaid and never creates a frame to warm it', () => {
  cache.has.mockReturnValue(true)
  const markdown = '```mermaid\nflowchart LR\nA-->B\n```'
  expect(hasCachedMermaid('flowchart LR\nA-->B\n', { appearance: 'light' })).toBe(true)
  warmMermaid(markdown, { appearance: 'light' })()
  expect(document.querySelector('iframe')).toBeNull()
})

it('does not treat a Gantt cached at another width as ready to draw eagerly', async () => {
  const source = 'gantt\n  title Sized\n  section Work\n  Task :a1, 2026-01-01, 1d\n'
  const content = await mermaidIsland.render(source, { appearance: 'light', width: 400 })
  try {
    expect(hasCachedMermaid(source, { appearance: 'light', width: 400 })).toBe(true)
    expect(hasCachedMermaid(source, { appearance: 'light', width: 800 })).toBe(false)
  } finally {
    content.dispose?.()
  }
})
