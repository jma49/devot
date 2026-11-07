// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealAnchor } from './paneAnchor'

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const pane = () => {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  return scroller
}

const anchor = () => {
  const block = document.createElement('section')
  block.dataset['anchor'] = 'pairing'
  return block
}

describe('a pane opened at an anchor', () => {
  it('scrolls to the anchor once the pane draws it', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const scroller = pane()
    revealAnchor(scroller, 'pairing')
    expect(scrolled).not.toHaveBeenCalled()
    const block = anchor()
    scroller.append(block)
    await vi.waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1))
    expect(scrolled.mock.contexts[0]).toBe(block)
  })

  it('scrolls at once to an anchor already drawn, and only once', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const scroller = pane()
    scroller.append(anchor())
    revealAnchor(scroller, 'pairing')
    scroller.append(document.createElement('p'))
    await Promise.resolve()
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('leaves the pane where it is once the owner touches it or the wait ends', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const touched = pane()
    revealAnchor(touched, 'pairing')
    touched.dispatchEvent(new Event('touchstart'))
    touched.append(anchor())
    vi.useFakeTimers()
    const late = pane()
    revealAnchor(late, 'pairing')
    vi.advanceTimersByTime(5000)
    vi.useRealTimers()
    late.append(anchor())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(scrolled).not.toHaveBeenCalled()
  })
})
