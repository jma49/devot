import { expect, it } from 'vitest'
import { budgetTable } from './budget-report'

const check = (test: string, value: number, budget: number, limit: number) => ({
  test,
  value,
  budget,
  limit,
})

it('lists the checks nearest their limits first, with how far over their budgets they ran', () => {
  const lines = budgetTable(
    [
      check('a.bench.test.ts > fast', 10, 50, 250),
      check('b.bench.test.ts > close', 240, 50, 250),
      check('c.bench.test.ts > growth', 4.2, 7, 7),
    ],
    10,
  )
  expect(lines).toEqual([
    '| Of limit | Measured | Of budget | Budget | Limit | Test |',
    '| ---: | ---: | ---: | ---: | ---: | --- |',
    '| 96% | 240 | 4.80x | 50 | 250 | b.bench.test.ts > close |',
    '| 60% | 4.20 | 0.60x | 7 | 7 | c.bench.test.ts > growth |',
    '| 4% | 10.0 | 0.20x | 50 | 250 | a.bench.test.ts > fast |',
  ])
})

it('keeps only the top rows and says how many checks there were', () => {
  const rows = [1, 2, 3].map((n) => check(`t${n}`, n, 10, 10))
  const lines = budgetTable(rows, 2)
  expect(lines.slice(2)).toEqual([
    '| 30% | 3.00 | 0.30x | 10 | 10 | t3 |',
    '| 20% | 2.00 | 0.20x | 10 | 10 | t2 |',
  ])
  expect(lines.at(-1)).not.toContain('t1')
})

it('has no table when no test checked a time', () => {
  expect(budgetTable([], 10)).toEqual([])
})
