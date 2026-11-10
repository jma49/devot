import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper for scripts/ci/iphone-ui-tests.sh: reads an xcodebuild test log and prints the
// -only-testing arguments of the tests to run once more.
// xcodebuild's own -retry-tests-on-failure runs a failed test again inside the test process, and a
// failed iPhone UI test ends that process: xcodebuild starts a new one for the tests that are left,
// and the failed test is never run again. On main, 10 of the 11 shards with a failed test lost
// their retry that way.

const RESULT = /^Test Case '-\[(\S+)\.(\S+) (\S+)\]' (failed|passed) /

export function runs(log: string): Map<string, { failed: number; passed: number }> {
  const seen = new Map<string, { failed: number; passed: number }>()
  for (const line of log.split('\n')) {
    const match = RESULT.exec(line)
    if (!match) continue
    const test = `${match[1]}/${match[2]}/${match[3]}`
    const count = seen.get(test) ?? { failed: 0, passed: 0 }
    count[match[4] as 'failed' | 'passed'] += 1
    seen.set(test, count)
  }
  return seen
}

/** Nothing when a test already failed twice: the job has failed, and a third run would hide it. */
export function retrySelection(log: string): string[] {
  const tests = [...runs(log)]
  if (tests.some(([, count]) => count.failed > 1 && count.passed === 0)) return []
  return tests
    .filter(([, count]) => count.failed === 1 && count.passed === 0)
    .map(([test]) => `-only-testing:${test}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  if (!path) throw new Error('E_XCTEST_RETRY_USAGE')
  console.log(retrySelection(readFileSync(path, 'utf8')).join(' '))
}
