import { describe, expect, it } from 'vitest'
import { summaryText, type SummaryFacts } from './summary'

const now = new Date(2026, 10, 6, 12, 0).getTime()

const facts = (extra: Partial<SummaryFacts> = {}): SummaryFacts => ({
  tasks: { done: 0, total: 0 },
  properties: 0,
  backlinks: 0,
  words: 0,
  updatedAt: now - 5 * 60_000,
  ...extra,
})

describe('the note summary', () => {
  it('lists tasks, properties and backlinks, then the words', () => {
    const all = facts({ tasks: { done: 1, total: 4 }, properties: 5, backlinks: 2, words: 1284 })
    expect(summaryText(all, 'en', now)).toBe('1/4 · 5 properties · 2 backlinks · 1,284 words')
  })

  it.each([
    [{ tasks: { done: 2, total: 3 } }, '2/3 · 10 words'],
    [{ properties: 3 }, '3 properties · 10 words'],
    [{ backlinks: 4 }, '4 backlinks · 10 words'],
    [{ tasks: { done: 0, total: 1 }, properties: 2 }, '0/1 · 2 properties · 10 words'],
    [{ tasks: { done: 1, total: 1 }, backlinks: 2 }, '1/1 · 2 backlinks · 10 words'],
    [{ properties: 2, backlinks: 3 }, '2 properties · 3 backlinks · 10 words'],
  ] satisfies [Partial<SummaryFacts>, string][])(
    'leaves out what the note does not have (%o)',
    (extra, text) => {
      expect(summaryText(facts({ words: 10, ...extra }), 'en', now)).toBe(text)
    },
  )

  it('says one of each in the singular', () => {
    const one = facts({ properties: 1, backlinks: 1, words: 1 })
    expect(summaryText(one, 'en', now)).toBe('1 property · 1 backlink · 1 word')
    expect(summaryText(facts({ properties: 1 }), 'en', now)).toBe('1 property · 0 words')
  })

  it('says when the note was updated when it has nothing else to list', () => {
    expect(summaryText(facts({ words: 212 }), 'en', now)).toBe('Updated 5 min ago · 212 words')
    expect(summaryText(facts({ words: 1, updatedAt: now }), 'en', now)).toBe(
      'Updated just now · 1 word',
    )
  })

  it('writes the numbers for the locale', () => {
    expect(summaryText(facts({ words: 1284, properties: 1000 }), 'de', now)).toContain('1.284')
  })
})
