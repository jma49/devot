import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Reporter, TestModule } from 'vitest/node'
import { budgetChecks, type BudgetCheck } from './budget'

// After a run, the time checks nearest their limits, in the log and the job summary: the evidence
// for HOSTED_RUNNER_SCALE and for each budget, gathered on every CI run.

type Row = BudgetCheck & { readonly test: string }

const TOP_ROWS = 40

export function budgetTable(rows: readonly Row[], top: number): string[] {
  if (rows.length === 0) return []
  const sorted = rows.toSorted((a, b) => b.value / b.limit - a.value / a.limit)
  return [
    '| Of limit | Measured | Of budget | Budget | Limit | Test |',
    '| ---: | ---: | ---: | ---: | ---: | --- |',
    ...sorted
      .slice(0, top)
      .map(
        (r) =>
          `| ${Math.round((100 * r.value) / r.limit)}% | ${r.value.toPrecision(3)} | ${(r.value / r.budget).toFixed(2)}x | ${r.budget} | ${r.limit} | ${r.test} |`,
      ),
  ]
}

export default class BudgetReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const rows: Row[] = []
    for (const module of modules) {
      const file = relative(process.cwd(), module.moduleId)
      for (const test of module.children.allTests()) {
        for (const check of budgetChecks(test.meta())) {
          rows.push({ ...check, test: `${file} > ${test.fullName}` })
        }
      }
    }
    const table = budgetTable(rows, TOP_ROWS)
    if (table.length === 0) return
    const text = [
      `Time checks nearest their limits (${rows.length} checks):`,
      '',
      ...table,
      '',
    ].join('\n')
    process.stdout.write(`\n${text}`)
    const summary = process.env['GITHUB_STEP_SUMMARY']
    if (summary) appendFileSync(summary, `### ${text}`)
  }
}
