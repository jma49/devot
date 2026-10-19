import { expect, type TestContext } from 'vitest'

// Time budgets in tests measure the machine as much as the code. A local
// machine running several suites at once cannot hold them, so there an
// over-budget measurement is reported as skipped, never as passed; CI always
// enforces the budget. Whether the machine is overloaded is asked at the
// moment of the check, through a probe the Node setup file installs
// (`machine-load.ts`). This module imports nothing from Node, so UI tests may
// use it too. Without a probe, every budget is enforced.
//
// The budgets are written for a developer's Mac. A shared GitHub-hosted runner
// (2 cores, other jobs on the same host) is several times slower and noisy, so
// there every budget is scaled by `HOSTED_RUNNER_SCALE`. It is sized from the
// first run on such a runner: the slowest check there took 4.0 times its
// budget (a 32 ms budget measured at 127 ms), the typical one 1.3 to 2.7
// times. 5 leaves headroom over that and still fails a regression of several
// times, which is what the budgets are for. Everywhere else, the budget is
// exact.

/** How many times the budgets stretch on a GitHub-hosted runner. */
export const HOSTED_RUNNER_SCALE = 5

/** The factor for the budgets in `env`: `HOSTED_RUNNER_SCALE` on a hosted CI runner, else 1. */
export function budgetScale(env: Readonly<Record<string, string | undefined>>): number {
  const hosted =
    Boolean(env['CI']) && (env['GITHUB_ACTIONS'] === 'true' || Boolean(env['RUNNER_OS']))
  return hosted ? HOSTED_RUNNER_SCALE : 1
}

const PROBE = Symbol.for('devot.test.overloaded')

type ProbeHost = { [PROBE]?: () => boolean }

export function setOverloadProbe(probe: () => boolean): void {
  ;(globalThis as ProbeHost)[PROBE] = probe
}

let scale = budgetScale(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
)

export function setBudgetScale(factor: number): void {
  scale = factor
}

function overloaded(): boolean {
  return (globalThis as ProbeHost)[PROBE]?.() ?? false
}

export function skipIfOverloaded(context: TestContext, why: string): void {
  if (overloaded()) context.skip(`machine overloaded (${why})`)
}

/**
 * Expects `ms` to be under `budgetMs` (stretched on a hosted CI runner, see
 * above). An over-budget measurement on an overloaded local machine skips the
 * test instead of failing it. `exact` keeps the budget unstretched, for a
 * known failure (`it.fails`) that must stay over its budget on every machine.
 */
export function expectWithinBudget(
  context: TestContext,
  ms: number,
  budgetMs: number,
  options: { readonly exact?: boolean } = {},
): void {
  const limit = options.exact ? budgetMs : budgetMs * scale
  if (ms >= limit) skipIfOverloaded(context, `${ms.toFixed(1)} ms of ${limit} ms`)
  expect(ms).toBeLessThan(limit)
}
