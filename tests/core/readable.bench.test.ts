import { describe, it } from 'vitest'
import { expectWithinBudget } from '../support/budget'
import { readableText } from '../../src/core'

describe('readableText on input made to be slow', () => {
  it('stays linear on input made to be slow', (context) => {
    const size = 200_000
    const inputs = [
      '['.repeat(size),
      '[['.repeat(size / 2) + ']]'.repeat(size / 2),
      '[^'.repeat(size / 2) + ']'.repeat(size / 2),
      '<!--'.repeat(size / 4),
      `[a <!--${'<!--'.repeat(size / 4)}](u) -->`,
      '<a:b'.repeat(size / 4),
      '`'.repeat(size),
      '*_~~'.repeat(size / 4),
      '['.repeat(size / 2) + '][]'.repeat(size / 2),
      `${'[x]('.repeat(size / 4)}${')'.repeat(size / 4)}`,
    ]
    const started = performance.now()
    for (const input of inputs) readableText(`x${input}\n${input}`)
    // Linear work takes well under a second; quadratic work takes minutes.
    expectWithinBudget(context, performance.now() - started, 10_000)
  }, 20_000)

  it('checks nested link destinations in linear time', (context) => {
    const k = 50_000
    const inputs = [
      // Every `(` opens a destination that runs to the one late space.
      `${'[a]('.repeat(k)} x${')'.repeat(k)}`,
      // Every `<` opens a destination that runs to the first `>`.
      '[a](<'.repeat(k) + '>)'.repeat(k),
    ]
    for (const input of inputs) {
      const started = performance.now()
      readableText(input)
      // Linear work takes milliseconds; quadratic work takes seconds.
      expectWithinBudget(context, performance.now() - started, 1_000)
    }
  })
})
