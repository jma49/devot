import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { retrySelection, runs } from '../../scripts/ci/xctest-retry'

const started = (test: string) => `Test Case '-[DevotUITests.${test}]' started (Iteration 1 of 2).`
const failed = (test: string) => `Test Case '-[DevotUITests.${test}]' failed (50.988 seconds).`
const passed = (test: string) => `Test Case '-[DevotUITests.${test}]' passed (41.076 seconds).`

// What a run on main logged: the test that failed was never run again, and the count left it out.
const lostRetry = [
  started('EditorTests testALink'),
  'EditorTests.swift:102: error: -[DevotUITests.EditorTests testALink] : XCTAssertTrue failed',
  failed('EditorTests testALink'),
  started('EditorTests testANote'),
  passed('EditorTests testANote'),
  '\t Executed 1 test, with 0 failures (0 unexpected) in 41.076 (41.080) seconds',
  '** TEST EXECUTE FAILED **',
].join('\n')

it('counts how often each test failed and passed', () => {
  expect(runs(lostRetry)).toEqual(
    new Map([
      ['DevotUITests/EditorTests/testALink', { failed: 1, passed: 0 }],
      ['DevotUITests/EditorTests/testANote', { failed: 0, passed: 1 }],
    ]),
  )
})

it('selects the tests that failed once and were not run again', () => {
  expect(retrySelection(lostRetry)).toEqual(['-only-testing:DevotUITests/EditorTests/testALink'])
})

it('selects nothing once xcodebuild ran a test again itself, whatever came of it', () => {
  const passedOnRetry = [failed('A testOne'), passed('A testOne')].join('\n')
  expect(retrySelection(passedOnRetry)).toEqual([])
  const failedTwice = [failed('A testOne'), failed('A testOne'), failed('B testTwo')].join('\n')
  expect(retrySelection(failedTwice)).toEqual([])
  expect(retrySelection('** TEST EXECUTE FAILED **')).toEqual([])
})

it('is what the iPhone UI test script runs a failed test again with', () => {
  const script = readFileSync('scripts/ci/iphone-ui-tests.sh', 'utf8')
  expect(script).toContain('node "$root/scripts/ci/xctest-retry.ts" "$log"')
  expect(script).toContain('-resultBundlePath "$retry_results" $again')
})
