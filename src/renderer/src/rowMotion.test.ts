import { describe, expect, it } from 'vitest'
import {
  enterFrames,
  leaveFrames,
  MAX_ROW_CHANGES,
  moveFrames,
  playsChange,
  rowChange,
  rowEnterTiming,
  rowMoveTiming,
} from './rowMotion'

describe('what changed in a list', () => {
  it('finds the rows that came and went', () => {
    const change = rowChange(['a', 'b', 'c'], ['d', 'a', 'c'])
    expect([...change.entered]).toEqual(['d'])
    expect([...change.left]).toEqual(['b'])
    expect(change.reordered).toBe(false)
  })

  it('finds rows that changed order', () => {
    expect(rowChange(['a', 'b', 'c'], ['c', 'a', 'b']).reordered).toBe(true)
    expect(rowChange(['a', 'b'], ['a', 'b']).reordered).toBe(false)
  })

  it('plays a small change only, never a list with nothing in common', () => {
    expect(playsChange(rowChange(['a'], ['a']), 1)).toBe(false)
    expect(playsChange(rowChange(['a'], ['b', 'a']), 1)).toBe(true)
    expect(playsChange(rowChange(['a'], ['b']), 0)).toBe(false)
    const many = Array.from({ length: MAX_ROW_CHANGES + 1 }, (_, i) => `n${i}`)
    expect(playsChange(rowChange(['a'], ['a', ...many]), 1)).toBe(false)
    expect(playsChange(rowChange(['a', 'b'], ['b', 'a']), 2)).toBe(true)
  })
})

describe('the motion of a row', () => {
  it('slides from its old place', () => {
    expect(moveFrames(-30)).toEqual([{ transform: 'translateY(-30px)' }, { transform: 'none' }])
  })

  it('fades in the sidebar, and grows to its height in the note list', () => {
    expect(enterFrames('slide', 30)).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(enterFrames('grow', 64)).toEqual([
      { opacity: 0, height: '0px' },
      { opacity: 1, height: '64px' },
    ])
    expect(leaveFrames('grow', 64)).toEqual([
      { opacity: 1, height: '64px' },
      { opacity: 0, height: '0px' },
    ])
  })

  it('takes 400 ms in the sidebar; 300 ms to come and 450 ms to move in the note list', () => {
    const slide = { duration: 400, easing: 'cubic-bezier(0.4, 0, 0.1, 1)' }
    expect(rowMoveTiming('slide')).toEqual(slide)
    expect(rowEnterTiming('slide')).toEqual(slide)
    expect(rowEnterTiming('grow')).toEqual({
      duration: 300,
      easing: 'cubic-bezier(0.25, 0.1, 0.35, 1)',
    })
    expect(rowMoveTiming('grow')).toEqual({ ...slide, duration: 450 })
  })
})
