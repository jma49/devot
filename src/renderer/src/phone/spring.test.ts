import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { phoneSpring } from './spring'

const peak = (easing: string): number =>
  Math.max(...[...easing.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0])))

describe('the phone springs', () => {
  it('settles within its budget', (context) => {
    expectWithinBudget(context, phoneSpring('gentle', 1).ms, 700)
    expectWithinBudget(context, phoneSpring('bouncy', 1).ms, 700)
  })

  it('bouncy overshoots to about 1.08 and gentle to about 1.03', () => {
    expect(peak(phoneSpring('bouncy', 1).easing)).toBeCloseTo(1.08, 1)
    expect(peak(phoneSpring('gentle', 1).easing)).toBeCloseTo(1.03, 1)
  })

  it('stretches with the motion scale', () => {
    expect(phoneSpring('gentle', 3).ms).toBeCloseTo(phoneSpring('gentle', 1).ms * 3)
  })
})
