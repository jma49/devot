// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchDragEnd, type DragEnd } from './dragEnd'

const pointer = (type: string, pointerId: number, target: EventTarget = window) =>
  target.dispatchEvent(new PointerEvent(type, { pointerId, bubbles: true }))

function watched(pointerId = 1) {
  const element = document.createElement('div')
  document.body.append(element)
  const ends: DragEnd[] = []
  const stop = watchDragEnd(element, pointerId, (how) => ends.push(how))
  return { element, ends, stop }
}

afterEach(() => document.body.replaceChildren())

describe('watchDragEnd', () => {
  it('releases on its own pointer going up, once', () => {
    const { element, ends } = watched()
    pointer('pointerup', 1, element)
    pointer('lostpointercapture', 1, element)
    pointer('pointerup', 1)
    expect(ends).toEqual(['release'])
  })

  it('cancels on a cancel or a lost capture of its own pointer', () => {
    const cancelled = watched()
    pointer('pointercancel', 1)
    expect(cancelled.ends).toEqual(['cancel'])
    const lost = watched()
    pointer('lostpointercapture', 1, lost.element)
    expect(lost.ends).toEqual(['cancel'])
  })

  it('ignores other fingers, and a capture lost by a child', () => {
    const { element, ends } = watched()
    const child = document.createElement('button')
    element.append(child)
    pointer('pointerup', 2, element)
    pointer('pointercancel', 2)
    pointer('lostpointercapture', 1, child)
    expect(ends).toEqual([])
  })

  it('cancels when the page is hidden or the window loses focus', () => {
    const hidden = watched()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.restoreAllMocks()
    expect(hidden.ends).toEqual(['cancel'])
    const blurred = watched()
    window.dispatchEvent(new Event('blur'))
    expect(blurred.ends).toEqual(['cancel'])
  })

  it('cancels when stopped, and after that hears nothing', () => {
    const { ends, stop } = watched()
    stop()
    stop()
    pointer('pointerup', 1)
    expect(ends).toEqual(['cancel'])
  })
})
