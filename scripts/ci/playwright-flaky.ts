import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: lists the UI tests that failed and passed on Playwright's retry (playwright.config.ts),
// from the shard's JSON report, as warning annotations and in the job summary, so a flake that no
// longer fails the run is still fixed. `node scripts/ci/playwright-flaky.ts <report.json>`.

type Spec = { title: string; file: string; tests: { status: string; projectName: string }[] }
type Suite = { specs?: Spec[]; suites?: Suite[] }

export function flakyTests(report: { suites?: Suite[] }): string[] {
  const found: string[] = []
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (test.status === 'flaky')
          found.push(`${spec.file} > ${spec.title} [${test.projectName}]`)
      }
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return found
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? 'test-results/report.json'
  if (existsSync(path)) {
    const flaky = flakyTests(JSON.parse(readFileSync(path, 'utf8')) as { suites?: Suite[] })
    for (const test of flaky) console.log(`::warning title=Flaky UI test::${test}`)
    const summary = process.env['GITHUB_STEP_SUMMARY']
    if (summary && flaky.length > 0) {
      const lines = flaky.map((test) => `- ${test}`).join('\n')
      appendFileSync(
        summary,
        `### Flaky: ${flaky.length} UI test(s) passed on retry\n\n${lines}\n\n`,
      )
    }
  }
}
