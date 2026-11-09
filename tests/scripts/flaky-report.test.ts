import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { flakyTests } from '../../scripts/ci/playwright-flaky'
import { flakyLines } from '../support/flaky-report'

const read = (path: string) => readFileSync(path, 'utf8')

it('lists the Vitest tests that passed on retry, and nothing for a clean run', () => {
  expect(flakyLines([])).toEqual([])
  expect(flakyLines(['tests/a.test.ts > saves'])).toEqual([
    'Flaky: 1 test(s) failed and passed on retry:',
    '',
    '- tests/a.test.ts > saves',
  ])
})

it("finds the flaky tests in nested suites of Playwright's JSON report", () => {
  const report = {
    suites: [
      {
        specs: [
          {
            title: 'opens',
            file: 'a.spec.ts',
            tests: [{ status: 'expected', projectName: 'webkit' }],
          },
        ],
        suites: [
          {
            specs: [
              {
                title: 'drags',
                file: 'b.spec.ts',
                tests: [{ status: 'flaky', projectName: 'webkit' }],
              },
              {
                title: 'fails',
                file: 'b.spec.ts',
                tests: [{ status: 'unexpected', projectName: 'webkit' }],
              },
            ],
          },
        ],
      },
    ],
  }
  expect(flakyTests(report)).toEqual(['b.spec.ts > drags [webkit]'])
  expect(flakyTests({})).toEqual([])
})

it('every CI test runner retries a failed test once and reports the tests that needed it', () => {
  // A one-off flake must not fail a merge or a release, and a flaky test must stay visible.
  const vitest = read('vitest.config.ts')
  expect(vitest).toContain('retry: ci ? 1 : 0')
  expect(vitest).toContain("'./tests/support/flaky-report.ts'")
  expect(read('playwright.config.ts')).toContain("retries: process.env['CI'] ? 1 : 0")
  const ci = parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps: { if?: string; run?: string }[] }>
  }
  const report = ci.jobs['ui']!.steps.find((step) =>
    step.run?.startsWith('node scripts/ci/playwright-flaky.ts'),
  )
  expect(report).toEqual({
    if: '${{ !cancelled() }}',
    run: 'node scripts/ci/playwright-flaky.ts test-results/report.json',
  })
  for (const script of ['iphone-ui-tests.sh', 'devot-screens-tests.sh']) {
    const text = read(`scripts/ci/${script}`)
    expect({ script, retry: text.includes('-retry-tests-on-failure -test-iterations 2') }).toEqual({
      script,
      retry: true,
    })
    expect({ script, reports: text.includes('passed on retry') }).toEqual({ script, reports: true })
  }
})
