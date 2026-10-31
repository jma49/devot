import { describe, expect, it } from 'vitest'
import { asAiAccessSummary } from './window'

describe('asAiAccessSummary', () => {
  it('accepts counts that fit together', () => {
    expect(asAiAccessSummary({ notebooks: 4, allowed: 1 })).toEqual({ notebooks: 4, allowed: 1 })
    expect(asAiAccessSummary({ notebooks: 0, allowed: 0 })).toEqual({ notebooks: 0, allowed: 0 })
  })

  it('refuses anything else', () => {
    for (const value of [
      null,
      {},
      { notebooks: 1 },
      { notebooks: -1, allowed: 0 },
      { notebooks: 1, allowed: 2 },
      { notebooks: 1.5, allowed: 1 },
      { notebooks: '1', allowed: 1 },
    ]) {
      expect(asAiAccessSummary(value)).toBeUndefined()
    }
  })
})
