import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  conceal,
  concealFrames,
  reveal,
  revealFrames,
  revealTiming,
  slideFrames,
  slideTiming,
} from './reveal'
import { sizes } from './theme/tokens'

describe('a section opening', () => {
  it('grows over the toggle duration on the move curve', () => {
    expect(revealTiming(false)).toEqual({
      duration: Number.parseFloat(sizes['motion.duration.toggle']),
      easing: sizes['motion.easing.move'],
    })
    expect(revealTiming(false)?.duration).toBe(200)
  })

  it('does not move under Reduce Motion', () => {
    expect(revealTiming(true)).toBeNull()
  })

  it('grows from nothing to its own height, fading in', () => {
    expect(revealFrames(84)).toEqual([
      { height: '0px', opacity: 0 },
      { height: '84px', opacity: 1 },
    ])
  })
})

describe('a section closing', () => {
  it('shrinks to nothing, fading out, over the same timing', () => {
    expect(concealFrames({ height: 84, opacity: 1 })).toEqual([
      { height: '84px', opacity: 1 },
      { height: '0px', opacity: 0 },
    ])
  })
})

class FakeAnimation extends EventTarget {
  constructor(readonly frames: Keyframe[]) {
    super()
  }
  cancel() {
    this.dispatchEvent(new Event('cancel'))
  }
  finish() {
    this.dispatchEvent(new Event('finish'))
  }
}

function section(drawn: { height: string; opacity: string }) {
  const played: FakeAnimation[] = []
  vi.stubGlobal('getComputedStyle', () => drawn)
  const el = {
    style: { overflow: 'visible' },
    scrollHeight: 120,
    animate: (frames: Keyframe[]) => {
      const animation = new FakeAnimation(frames)
      played.push(animation)
      return animation
    },
  }
  return { el: el as unknown as HTMLElement, played }
}

describe('a section toggled again before it has finished', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('turns a close back from where it is, and never closes', () => {
    const { el, played } = section({ height: '45px', opacity: '0.4' })
    const closed = vi.fn<() => void>()
    conceal(el, closed)
    expect(played[0]?.frames[0]).toEqual({ height: '120px', opacity: 1 })
    reveal(el)
    expect(played[1]?.frames).toEqual([
      { height: '45px', opacity: 0.4 },
      { height: '120px', opacity: 1 },
    ])
    played[1]?.finish()
    expect(closed).not.toHaveBeenCalled()
    expect(el.style.overflow).toBe('visible')
  })

  it('closes an open under way from where it is, never from its full height', () => {
    const { el, played } = section({ height: '45px', opacity: '0.4' })
    reveal(el)
    const closed = vi.fn<() => void>()
    conceal(el, closed)
    expect(played[1]?.frames).toEqual([
      { height: '45px', opacity: 0.4 },
      { height: '0px', opacity: 0 },
    ])
    expect(el.style.overflow).toBe('hidden')
    played[1]?.finish()
    expect(closed).toHaveBeenCalledOnce()
  })
})

describe('the sidebar sliding to or from a workspace', () => {
  it('slides over 380 ms on the move curve, and not under Reduce Motion', () => {
    expect(slideTiming(false)).toEqual({ duration: 380, easing: sizes['motion.easing.move'] })
    expect(slideTiming(true)).toBeNull()
  })

  it('comes in from the right going deeper and from the left going back, fading in', () => {
    expect(slideFrames(1)[0]).toEqual({ transform: 'translateX(80px)', opacity: 0 })
    expect(slideFrames(-1)[0]).toEqual({ transform: 'translateX(-80px)', opacity: 0 })
    expect(slideFrames(1)[1]).toEqual({ transform: 'none', opacity: 1 })
  })
})
