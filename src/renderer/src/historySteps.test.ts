import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../core'
import { inlineDiff } from '../../core/diff'
import {
  axisAt,
  compactionLimited,
  historySteps,
  pastOffset,
  removedWithin,
  scrubKey,
  stepNearest,
  tickHeight,
} from './historySteps'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const body = (id: string, at: number, length: number, change: number | null): HistoryEntry => ({
  id,
  kind: 'body',
  at,
  length,
  change,
  merge: false,
})

describe('the history bar', () => {
  it('steps through the body versions oldest first, sized by characters changed', () => {
    const steps = historySteps([
      body('b', 2000, 30, -10),
      { id: 't', kind: 'title', at: 1500, value: 'Plan' },
      body('a', 1000, 40, null),
    ])
    expect(steps.map((s) => [s.id, s.chars])).toEqual([
      ['a', null],
      ['b', 10],
    ])
  })

  it('sizes a version by the characters it changed, so a rewrite of the same length shows', () => {
    const steps = historySteps([body('b', 2000, 40, 0), body('a', 1000, 40, null)], { b: 25 })
    expect(steps.map((s) => s.chars)).toEqual([null, 25])
    expect(tickHeight(null, 25)).toBe(tickHeight(0, 25))
    expect(tickHeight(25, 25)).toBe(1)
  })

  it('places a version on a time axis from the oldest to now', () => {
    expect(axisAt(1000, 1000, 3000)).toBe(0)
    expect(axisAt(2000, 1000, 3000)).toBe(0.5)
    expect(axisAt(3000, 1000, 3000)).toBe(1)
    expect(axisAt(5000, 5000, 5000)).toBe(1)
  })

  it('picks the version nearest a point, or the current text past the last', () => {
    const steps = historySteps([body('a', 0, 5, null), body('b', 600, 9, 4)])
    expect(stepNearest(0, steps, 0, 1000)).toBe(0)
    expect(stepNearest(0.2, steps, 0, 1000)).toBe(0)
    expect(stepNearest(0.5, steps, 0, 1000)).toBe(1)
    expect(stepNearest(0.9, steps, 0, 1000)).toBe(2)
    expect(stepNearest(1.4, steps, 0, 1000)).toBe(2)
    expect(stepNearest(0.5, [], 0, 1000)).toBe(0)
  })

  it('draws a tick at least a fifth high, the most changed full height', () => {
    expect(tickHeight(0, 100)).toBe(0.2)
    expect(tickHeight(100, 100)).toBe(1)
    expect(tickHeight(25, 100)).toBeCloseTo(0.6)
    expect(tickHeight(5, 0)).toBe(0.2)
  })

  it('says compaction thins what it shows once a version is over a day old', () => {
    const now = 10 * DAY
    expect(compactionLimited(historySteps([body('a', now - HOUR, 1, null)]), now)).toBe(false)
    expect(compactionLimited(historySteps([body('a', now - 2 * DAY, 1, null)]), now)).toBe(true)
  })

  it('moves with the keys of a slider, End being the current text', () => {
    expect(scrubKey('ArrowLeft', 3, 5)).toBe(2)
    expect(scrubKey('ArrowDown', 0, 5)).toBe(0)
    expect(scrubKey('ArrowRight', 4, 5)).toBe(5)
    expect(scrubKey('ArrowUp', 5, 5)).toBe(5)
    expect(scrubKey('Home', 3, 5)).toBe(0)
    expect(scrubKey('End', 1, 5)).toBe(5)
    expect(scrubKey('PageDown', 9, 20)).toBe(0)
    expect(scrubKey('PageUp', 9, 20)).toBe(19)
    expect(scrubKey('a', 1, 5)).toBeUndefined()
  })

  it('reads a point in the shown text as an offset in the version', () => {
    const segments = inlineDiff('keep old end', 'keep new end')
    expect(segments.map((s) => s.kind)).toEqual(['same', 'removed', 'added', 'same'])
    expect(pastOffset(segments, 0, 2)).toBe(2)
    expect(pastOffset(segments, 1, 1)).toBe(6)
    expect(pastOffset(segments, 2, 2)).toBe(8)
    expect(pastOffset(segments, 3, 0)).toBe(8)
    expect(pastOffset(segments, 3, 4)).toBe(12)
  })

  it('offers a passage back only where the range takes in removed text', () => {
    const segments = inlineDiff('keep old end', 'keep new end')
    expect(removedWithin(segments, 0, 4)).toBe(false)
    expect(removedWithin(segments, 4, 7)).toBe(true)
    expect(removedWithin(segments, 8, 12)).toBe(false)
    expect(removedWithin(segments, 6, 6)).toBe(false)
  })
})
