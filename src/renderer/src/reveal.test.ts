import { describe, expect, it } from 'vitest'
import { concealFrames, revealFrames, revealTiming, slideFrames, slideTiming } from './reveal'
import { sizes } from './theme/tokens'

describe('a section opening', () => {
  it('grows over the toggle duration on the ease-out curve', () => {
    expect(revealTiming(false)).toEqual({
      duration: Number.parseFloat(sizes['motion.duration.toggle']),
      easing: sizes['motion.easing.out'],
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
    expect(concealFrames(84)).toEqual([
      { height: '84px', opacity: 1 },
      { height: '0px', opacity: 0 },
    ])
  })
})

describe('the sidebar sliding to or from a workspace', () => {
  it('slides over the pane duration on the standard curve, and not under Reduce Motion', () => {
    expect(slideTiming(false)).toEqual({
      duration: Number.parseFloat(sizes['motion.duration.pane']),
      easing: sizes['motion.easing.standard'],
    })
    expect(slideTiming(true)).toBeNull()
  })

  it('comes in from the right going deeper and from the left going back, fading in', () => {
    expect(slideFrames(1)[0]).toEqual({ transform: 'translateX(24px)', opacity: 0 })
    expect(slideFrames(-1)[0]).toEqual({ transform: 'translateX(-24px)', opacity: 0 })
    expect(slideFrames(1)[1]).toEqual({ transform: 'none', opacity: 1 })
  })
})
