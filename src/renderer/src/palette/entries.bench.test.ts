import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { outlineEntries } from './entries'

// The palette reads a note's outline whenever its text changes. A heading with a long whitespace
// run once made the end-anchored heading pattern backtrack over the run; the read is linear now.
const RUN = 200_000
const BUDGET_MS = 25

describe('the palette outline', () => {
  it('reads a heading with a long whitespace run within budget', (context) => {
    const doc = `# ${' '.repeat(RUN)}title${' '.repeat(RUN)}#\n\n## Part\n- [ ] task`
    for (let i = 0; i < 3; i += 1) outlineEntries(doc)
    const started = performance.now()
    const entries = outlineEntries(doc)
    expectWithinBudget(context, performance.now() - started, BUDGET_MS)
    expect(entries.map((e) => e.label)).toEqual(['title', 'Part', 'task'])
  })
})
