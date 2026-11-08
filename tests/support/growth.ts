import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { expect, type TestContext } from 'vitest'
import { recordBudgetCheck, skipIfOverloaded } from './budget'

// Whether work grows linearly, as a ratio of two sizes measured on the same machine moments apart,
// so no budget depends on how fast the machine is: four times the input takes about 4 times as
// long in linear time and up to 16 times in quadratic time. Time is the process's CPU time, which a
// busy machine inflates far less than the clock on the wall. An untimed warm-up of both sizes comes
// first, so compilation of the code under test does not weigh on the small size alone, and each
// timing starts after a collection, so the garbage of building the input is not paid for in it.
// Each round then runs both sizes, so load that drifts meanwhile weighs on both, and the median of
// the rounds counts (the fastest of a few was often a lucky small run that inflated the ratio). A
// busy hosted runner has measured linear work at 6.5, so a check must have quadratic work at 9 or
// more.

const LIMIT = 7

/** For a growth test that builds large inputs: Vitest's 5 s default is too short for the warm-up and rounds. */
export const GROWTH_TIMEOUT = 30_000

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const timed = (work: () => void) => {
  collect()
  const start = process.cpuUsage()
  work()
  const { user, system } = process.cpuUsage(start)
  return user + system
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] as number

/**
 * The process's CPU milliseconds for `work`, after a collection. Waits on timers and the disk cost
 * nothing, so what a busy runner's disk does to the clock on the wall does not count.
 */
export async function cpuMs(work: () => Promise<unknown>): Promise<number> {
  collect()
  const start = process.cpuUsage()
  await work()
  const { user, system } = process.cpuUsage(start)
  return (user + system) / 1000
}

/** As fourfoldGrowth, for async work; with the median CPU milliseconds of the larger size. */
export async function fourfoldGrowthAsync(
  prepare: (n: number) => Promise<() => Promise<unknown>>,
  n: number,
  rounds = 3,
): Promise<{ growth: number; largeMs: number }> {
  await cpuMs(await prepare(n))
  await cpuMs(await prepare(4 * n))
  const small: number[] = []
  const large: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    small.push(await cpuMs(await prepare(n)))
    large.push(await cpuMs(await prepare(4 * n)))
  }
  return { growth: median(large) / median(small), largeMs: median(large) }
}

/** `prepare(n)` builds the input of size `n` (untimed) and returns the work to time. */
export function fourfoldGrowth(prepare: (n: number) => () => void, n: number, rounds = 5): number {
  timed(prepare(n))
  timed(prepare(4 * n))
  const small: number[] = []
  const large: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    small.push(timed(prepare(n)))
    large.push(timed(prepare(4 * n)))
  }
  return median(large) / median(small)
}

/** Over the limit on an overloaded local machine skips instead of failing, as budgets do. */
export function expectLinearGrowth(context: TestContext, growth: number): void {
  recordBudgetCheck(context, { value: growth, budget: LIMIT, limit: LIMIT })
  if (growth >= LIMIT) skipIfOverloaded(context, `grew ${growth.toFixed(1)} times`)
  expect(growth).toBeLessThan(LIMIT)
}
