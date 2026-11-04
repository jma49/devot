import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { markSegments } from './authorship'

// A frame's budget: out of the fast suite, so it never shares the CPU with it.

describe('markSegments', () => {
  it('keeps a typed key quick in a note with thousands of agent runs', (context) => {
    const lines = 5_000
    const long = Text.of(Array.from({ length: lines }, (_, i) => `line ${i}`))
    const runs = Array.from({ length: lines }, (_, i) => {
      const line = long.line(i + 1)
      return { from: line.from, to: line.to, writeId: `w${i % 7}` }
    })
    // The fastest of three: a garbage collection can stretch one run, but a slow path is slow every time.
    let fastest = Infinity
    for (let run = 0; run < 3; run++) {
      const started = performance.now()
      const segments = markSegments(runs, (pos) => long.lineAt(pos).number)
      fastest = Math.min(fastest, performance.now() - started)
      expect(segments).toHaveLength(lines)
    }
    expectWithinBudget(context, fastest, 16)
  })
})
