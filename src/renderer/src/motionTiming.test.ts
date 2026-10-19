import { describe, expect, it } from 'vitest'
import { motionMs, motionTiming, parseMotionScale, scaledDurations } from './motionTiming'

describe('the motion speed factor', () => {
  it('takes a positive stored number, and 1 for anything else', () => {
    expect(parseMotionScale('5')).toBe(5)
    expect(parseMotionScale('0.5')).toBe(0.5)
    for (const stored of [null, '', '0', '-2', 'slow', 'Infinity'])
      expect(parseMotionScale(stored)).toBe(1)
  })

  it('slows the timings played from code', () => {
    expect(motionMs('motion.duration.slide', 1)).toBe(380)
    expect(motionTiming('motion.duration.slide', 'motion.easing.move', 5)).toEqual({
      duration: 1900,
      easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
    })
  })

  it('slows every stylesheet duration by the same factor, and sets nothing at 1', () => {
    expect(scaledDurations(1)).toEqual([])
    const scaled = new Map(scaledDurations(2))
    expect(scaled.get('--motion-duration-slide')).toBe('760ms')
    expect(scaled.get('--motion-duration-hover')).toBe('360ms')
    expect([...scaled.keys()].every((name) => name.startsWith('--motion-duration-'))).toBe(true)
  })
})
