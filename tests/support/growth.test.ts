import { expect, it, type TestContext } from 'vitest'
import { budgetChecks, expectWithinBudget } from './budget'
import { cpuMs, expectLinearGrowth, fourfoldGrowthAsync } from './growth'

const burn = (iterations: number) => {
  let x = 0
  for (let i = 0; i < iterations; i += 1) x = (x * 31 + i) % 1_000_003
  return x
}

it('records the growth it checked on its test', () => {
  const task = { meta: {} }
  expectLinearGrowth({ task } as unknown as TestContext, 4.2)
  expect(budgetChecks(task.meta)).toEqual([{ value: 4.2, budget: 7, limit: 7 }])
})

it('times async work by the CPU it uses, not the time it waits', async (context) => {
  const waited = await cpuMs(() => new Promise((resolve) => setTimeout(resolve, 200)))
  const worked = await cpuMs(async () => burn(5_000_000))
  expectWithinBudget(context, waited, 100, { exact: true })
  expect(worked).toBeGreaterThan(0)
})

it('prepares both sizes untimed, then each round, with the larger size timed', async () => {
  const sizes: number[] = []
  const { growth, largeMs } = await fourfoldGrowthAsync(
    async (n) => {
      sizes.push(n)
      return async () => burn(n)
    },
    500_000,
    3,
  )
  expect(sizes).toEqual([
    500_000, 2_000_000, 500_000, 2_000_000, 500_000, 2_000_000, 500_000, 2_000_000,
  ])
  expect(growth).toBeGreaterThan(1)
  expect(largeMs).toBeGreaterThan(0)
})
