import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const read = (path: string) => readFileSync(path, 'utf8')

it('a failed Vitest or Playwright test fails CI on its first run, and the XCUITests run one once more', () => {
  // A retry turned a flaky test green, so it stayed unfixed and each flake cost a run (docs/specs/quality.md, Flaky tests).
  expect(read('vitest.config.ts')).not.toMatch(/\bretry\s*:/)
  expect(read('playwright.config.ts')).not.toMatch(/\bretries\s*:/)
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
