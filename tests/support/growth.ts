import { expect, type TestContext } from 'vitest'
import { skipIfOverloaded } from './budget'

// Whether work grows linearly, as a ratio of two sizes measured on the same machine moments apart,
// so no budget depends on how fast the machine is: four times the input takes about 4 times as
// long in linear time and up to 16 times in quadratic time. Each round runs both sizes, so load
// that drifts meanwhile weighs on both, and the fastest of the rounds counts. A busy hosted runner
// has measured linear work at 6.5, so a check must have quadratic work at 9 or more.

const LIMIT = 7

const timed = (work: () => void) => {
  const start = performance.now()
  work()
  return performance.now() - start
}

/** `prepare(n)` builds the input of size `n` (untimed) and returns the work to time. */
export function fourfoldGrowth(prepare: (n: number) => () => void, n: number, rounds = 3): number {
  let small = Number.POSITIVE_INFINITY
  let large = Number.POSITIVE_INFINITY
  for (let round = 0; round < rounds; round += 1) {
    small = Math.min(small, timed(prepare(n)))
    large = Math.min(large, timed(prepare(4 * n)))
  }
  return large / small
}

/** Over the limit on an overloaded local machine skips instead of failing, as budgets do. */
export function expectLinearGrowth(context: TestContext, growth: number): void {
  if (growth >= LIMIT) skipIfOverloaded(context, `grew ${growth.toFixed(1)} times`)
  expect(growth).toBeLessThan(LIMIT)
}
