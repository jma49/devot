// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"disableIframePageLoading":false}}
import { afterEach, expect, it, vi } from 'vitest'
import { hasCachedMermaid, warmMermaid } from './mermaid'
import { READY } from './mermaid-protocol'
import { FRAME_IDLE_MS } from './frameLifetime'

const cache = vi.hoisted(() => ({
  has: vi.fn<(predicate: (key: string) => boolean) => boolean>(() => false),
}))
vi.mock('./kept', () => ({ keptAnswers: () => cache }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cache.has.mockReturnValue(false)
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
    expect(hasCachedMermaid(markdown, { appearance: 'light' })).toBe(false)
    expect(document.querySelector('iframe')).toBeNull()
  },
)

it('recognizes a cached first Mermaid and never creates a frame to warm it', () => {
  cache.has.mockReturnValue(true)
  const markdown = '```mermaid\nflowchart LR\nA-->B\n```'
  expect(hasCachedMermaid(markdown, { appearance: 'light' })).toBe(true)
  warmMermaid(markdown, { appearance: 'light' })()
  expect(document.querySelector('iframe')).toBeNull()
})
