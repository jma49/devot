import { describe, expect, it } from 'vitest'
import { DAY_MS, WRITING_WEEKS, weekday } from '../../core/activity'
import { monthLabels } from './activityMonths'

const firstOf = (date: string, weeks: number) => {
  const today = Date.parse(date) / DAY_MS
  return today - weekday(today) - (weeks - 1) * 7
}

describe('monthLabels', () => {
  it('labels the current month when it starts in the last week shown', () => {
    const labels = monthLabels(firstOf('2026-11-05', WRITING_WEEKS), WRITING_WEEKS, 'en-US')
    expect(labels.at(-1)).toBe('Nov')
    expect(labels.filter(Boolean)).toEqual(['Aug', 'Sep', 'Oct', 'Nov'])
  })

  it('labels a month that starts in the second-to-last week', () => {
    const labels = monthLabels(firstOf('2026-11-12', WRITING_WEEKS), WRITING_WEEKS, 'en-US')
    expect(labels.at(-2)).toBe('Nov')
    expect(labels.at(-1)).toBe('')
  })

  it('labels the first week unless the next label is too close', () => {
    expect(monthLabels(firstOf('2026-11-05', WRITING_WEEKS), WRITING_WEEKS, 'en-US')[0]).toBe('')
    expect(monthLabels(firstOf('2026-10-14', WRITING_WEEKS), WRITING_WEEKS, 'en-US')[0]).toBe('Jul')
  })
})
