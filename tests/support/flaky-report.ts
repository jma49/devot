import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Reporter, TestModule } from 'vitest/node'

// CI retries a failed test once (vitest.config.ts), so a one-off flake does not fail a merge or a
// release. A test that passed only on its retry is listed here, in the log, as a warning annotation
// and in the job summary, so it is fixed rather than forgotten.

export function flakyLines(tests: readonly string[]): string[] {
  if (tests.length === 0) return []
  return [
    `Flaky: ${tests.length} test(s) failed and passed on retry:`,
    '',
    ...tests.map((test) => `- ${test}`),
  ]
}

export default class FlakyReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const flaky: string[] = []
    for (const module of modules) {
      const file = relative(process.cwd(), module.moduleId)
      for (const test of module.children.allTests()) {
        if (test.diagnostic()?.flaky) flaky.push(`${file} > ${test.fullName}`)
      }
    }
    const lines = flakyLines(flaky)
    if (lines.length === 0) return
    process.stdout.write(`\n${lines.join('\n')}\n`)
    for (const test of flaky) process.stdout.write(`::warning title=Flaky test::${test}\n`)
    const summary = process.env['GITHUB_STEP_SUMMARY']
    if (summary) appendFileSync(summary, `### ${lines.join('\n')}\n\n`)
  }
}
