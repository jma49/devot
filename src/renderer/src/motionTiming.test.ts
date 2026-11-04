import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOTION_SCALE_KEY,
  motionMs,
  motionScale,
  motionTiming,
  parseMotionScale,
  scaledDurations,
} from './motionTiming'

describe('the motion speed factor', () => {
  it('takes a positive stored number, and 1 for anything else', () => {
    expect(parseMotionScale('5')).toBe(5)
    expect(parseMotionScale('0.5')).toBe(0.5)
    for (const stored of [null, '', '0', '-2', 'slow', 'Infinity'])
      expect(parseMotionScale(stored)).toBe(1)
  })

  describe('read from storage', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    })
    const build = (dev: boolean, uiTest: boolean) => {
      vi.stubEnv('DEV', dev)
      vi.stubGlobal('DEVOT_UI_TEST', uiTest)
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => (key === MOTION_SCALE_KEY ? '5' : null),
      })
    }

    it("is read in development builds and the UI tests' build, which the motion tests slow", () => {
      build(true, false)
      expect(motionScale()).toBe(5)
      build(false, true)
      expect(motionScale()).toBe(5)
    })

    it('is ignored by the app as it ships', () => {
      build(false, false)
      expect(motionScale()).toBe(1)
    })
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
