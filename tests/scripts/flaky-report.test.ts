import { readdirSync, readFileSync } from 'node:fs'
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
  for (const script of ['iphone-ui-tests.sh', 'devot-screens-tests.sh', 'devot-store-tests.sh']) {
    const text = read(`scripts/ci/${script}`)
    expect({ script, retry: text.includes('-retry-tests-on-failure -test-iterations 2') }).toEqual({
      script,
      retry: true,
    })
    expect({ script, reports: text.includes('passed on retry') }).toEqual({ script, reports: true })
  }
})

it("scales every wait of the iPhone UI test by CI's factor, so a loaded runner does not fail it", () => {
  // The waits are sized on an idle simulator (Tests/Waits.swift); a bare number would not stretch.
  const dir = 'src-tauri/apple/DevotUITests/Tests'
  const bare = readdirSync(dir)
    .filter((file) => file.endsWith('.swift') && file !== 'Waits.swift')
    .flatMap((file) =>
      read(`${dir}/${file}`)
        .split('\n')
        .map((line, i) => ({ at: `${file}:${i + 1}`, line }))
        .filter(({ line }) => /timeout: \d/.test(line) && !/waitUntil\(/.test(line)),
    )
    .map(({ at }) => at)
  expect(bare).toEqual([])
  expect(read(`${dir}/Waits.swift`)).toContain(
    'ProcessInfo.processInfo.environment["DEVOT_UI_WAIT_SCALE"]',
  )
  expect(read('scripts/ci/iphone-ui-tests.sh')).toContain(
    'export TEST_RUNNER_DEVOT_UI_WAIT_SCALE="${DEVOT_UI_WAIT_SCALE:-1}"',
  )
  const ci = parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { env?: Record<string, string> }>
  }
  expect(ci.jobs['iphone-ui']!.env?.['DEVOT_UI_WAIT_SCALE']).toBe('3')
})
