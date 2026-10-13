import { describe, expect, it } from 'vitest'
import { revealFrames, revealTiming } from './reveal'
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
