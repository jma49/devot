import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { RAW_TIME_ASSERTION } from '../support/policy-patterns'

// Several checkouts often run their suites on one machine at once; a time limit checked by hand fails
// there for no reason, while expectWithinBudget skips when the machine is overloaded.
it('every time limit goes through expectWithinBudget', () => {
  const files = listFiles('.', 'tests', 'src').filter(
    (f) =>
      /\.(ts|tsx)$/.test(f) &&
      f !== 'tests/support/budget.ts' &&
      f !== 'tests/policy/time-budgets.test.ts',
  )
  const offenders = files.filter((file) => RAW_TIME_ASSERTION.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('the time-limit check catches a duration compared by hand', () => {
  expect(RAW_TIME_ASSERTION.test('expect(ms).toBeLessThan(2000)')).toBe(true)
  expect(RAW_TIME_ASSERTION.test('expect(elapsed).toBeLessThan(limit)')).toBe(true)
  expect(RAW_TIME_ASSERTION.test('expectWithinBudget(context, ms, 2000)')).toBe(false)
  expect(RAW_TIME_ASSERTION.test('expect(items).toBeLessThan(3)')).toBe(false)
})
