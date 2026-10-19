import { describe, expect, it } from 'vitest'
import {
  clipInset,
  enterFrames,
  leaveFrames,
  MAX_ROW_CHANGES,
  moveFrames,
  playsChange,
  rowChange,
  rowEnterTiming,
  rowMoveTiming,
  sameKeys,
} from './rowMotion'

describe('what changed in a list', () => {
  it('sees an equal list in a new array as no change', () => {
    expect(sameKeys(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameKeys(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameKeys(['a'], ['a', 'b'])).toBe(false)
  })

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
    expect(moveFrames(-30)).toEqual([
      { transform: 'translateY(-30px)' },
      { transform: 'translateY(0px)' },
    ])
  })

  it('fades in or out without changing its height, so the list is laid out once', () => {
    expect(enterFrames).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(leaveFrames()).toEqual([{ opacity: 1 }, { opacity: 0 }])
    expect(JSON.stringify([enterFrames, leaveFrames()])).not.toContain('height')
  })

  it('fades out from how opaque it is, so a row still coming in never brightens', () => {
    expect(leaveFrames(0.3)).toEqual([{ opacity: 0.3 }, { opacity: 0 }])
  })

  it('moves over 380 ms; comes over 380 ms in the sidebar and 300 ms in the note list', () => {
    const slide = { duration: 380, easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)' }
    expect(rowMoveTiming()).toEqual(slide)
    expect(rowEnterTiming('slide')).toEqual(slide)
    expect(rowEnterTiming('grow')).toEqual({ ...slide, duration: 300 })
  })
})

describe('a leaving row drawn only where the list shows', () => {
  const box = { top: 100, right: 300, bottom: 160, left: 0 }

  it('is not clipped inside the list', () => {
    expect(clipInset(box, { top: 0, right: 400, bottom: 900, left: 0 })).toBe('none')
  })

  it('is cut where the list header or the next pane begins', () => {
    expect(clipInset(box, { top: 130, right: 280, bottom: 900, left: 0 })).toBe(
      'inset(30px 20px 0px 0px)',
    )
  })

  it('is not drawn at all once scrolled out of sight', () => {
    expect(clipInset(box, { top: 160, right: 400, bottom: 900, left: 0 })).toBeNull()
  })
})
