import { expect, type TestContext } from 'vitest'

// Time budgets in tests measure the machine as much as the code. A local
// machine running several suites at once cannot hold them, so there an
// over-budget measurement is reported as skipped, never as passed; CI always
// enforces the budget. Whether the machine is overloaded is asked at the
// moment of the check, through a probe the Node setup file installs
// (`machine-load.ts`). This module imports nothing from Node, so UI tests may
// use it too. Without a probe, every budget is enforced.

const PROBE = Symbol.for('devot.test.overloaded')

type ProbeHost = { [PROBE]?: () => boolean }

/** Installs the check for an overloaded machine; the Node setup file calls it. */
export function setOverloadProbe(probe: () => boolean): void {
  ;(globalThis as ProbeHost)[PROBE] = probe
}

function overloaded(): boolean {
  return (globalThis as ProbeHost)[PROBE]?.() ?? false
}

/** Skips the running test, with `why` as the note, when the local machine is overloaded. */
export function skipIfOverloaded(context: TestContext, why: string): void {
  if (overloaded()) context.skip(`machine overloaded (${why})`)
}

/**
 * Expects `ms` to be under `budgetMs`. An over-budget measurement on an
 * overloaded local machine skips the test instead of failing it.
 */
export function expectWithinBudget(context: TestContext, ms: number, budgetMs: number): void {
  if (ms >= budgetMs) skipIfOverloaded(context, `${ms.toFixed(1)} ms of ${budgetMs} ms`)
  expect(ms).toBeLessThan(budgetMs)
}
