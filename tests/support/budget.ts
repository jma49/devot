import { expect, type TestContext } from 'vitest'

// Time budgets measure the machine as much as the code. Locally, an over-budget measurement on an
// overloaded machine is skipped, never passed; CI always enforces. Load is asked at check time through a
// probe the Node setup file installs (`machine-load.ts`); without one every budget is enforced. This
// module imports nothing from Node, so UI tests may use it too.
//
// Budgets are written for a developer's Mac. A shared GitHub-hosted runner is several times slower and
// noisy, so there they scale by `HOSTED_RUNNER_SCALE`: the first run there had the slowest check at 4.0
// times its budget (typical 1.3 to 2.7), and 5 still fails a regression of several times.

export const HOSTED_RUNNER_SCALE = 5

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
 * Expects `ms` under `budgetMs` (stretched on a hosted runner). Over budget on an overloaded local
 * machine skips instead of failing. `exact` keeps the budget unstretched, for an `it.fails` that
 * must stay over its budget on every machine.
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
