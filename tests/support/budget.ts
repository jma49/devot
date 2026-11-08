import { expect } from 'vitest'

// Time budgets measure the machine as much as the code. Locally, an over-budget measurement on an
// overloaded machine is skipped, never passed; CI always enforces. Load is asked at check time through a
// probe the Node setup file installs (`machine-load.ts`); without one every budget is enforced. This
// module imports nothing from Node, so UI tests may use it too.
//
// Budgets are written for a developer's Mac. A shared GitHub-hosted runner is slower and noisy, so
// there they scale by `HOSTED_RUNNER_SCALE`. Over the four CI runs of #777, with the builds kept apart and
// checks of work that writes to disk timed in CPU, the slowest check ran at 3.3 times its budget and
// all others under 2; 5 leaves room above that and still fails a regression of a few times. Each CI
// run lists the measurements nearest their limits (budget-report.ts).

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

/** One time check: what it measured, its budget as written and the limit it was held to. */
export type BudgetCheck = {
  readonly value: number
  readonly budget: number
  readonly limit: number
}

type BudgetMeta = { budgets?: BudgetCheck[] }

/** What a check needs of its test: Vitest's context, or one a Playwright test makes from `test.skip`. */
export type BudgetContext = {
  readonly task?: { readonly meta: object } | undefined
  skip(note?: string): void
}

/** The checks a test made, from its task's meta (where Vitest carries them to the reporters). */
export function budgetChecks(meta: object | undefined): readonly BudgetCheck[] {
  return (meta as BudgetMeta | undefined)?.budgets ?? []
}

export function recordBudgetCheck(context: BudgetContext, check: BudgetCheck): void {
  const meta = context.task?.meta as BudgetMeta | undefined
  if (meta) (meta.budgets ??= []).push(check)
}

export function skipIfOverloaded(context: BudgetContext, why: string): void {
  if (overloaded()) context.skip(`machine overloaded (${why})`)
}

/**
 * Expects `ms` under `budgetMs` (stretched on a hosted runner). Over budget on an overloaded local
 * machine skips instead of failing. `exact` keeps the budget unstretched, for an `it.fails` that
 * must stay over its budget on every machine, or for a budget made of another measurement taken
 * on the same machine.
 */
export function expectWithinBudget(
  context: BudgetContext,
  ms: number,
  budgetMs: number,
  options: { readonly exact?: boolean } = {},
): void {
  const limit = options.exact ? budgetMs : budgetMs * scale
  recordBudgetCheck(context, { value: ms, budget: budgetMs, limit })
  if (ms >= limit) skipIfOverloaded(context, `${ms.toFixed(1)} ms of ${limit} ms`)
  expect(ms).toBeLessThan(limit)
}
