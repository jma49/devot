import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { REST, SHARDS, SMOKE, selection } from '../../scripts/ci/iphone-ui-shards'

const tests = 'src-tauri/apple/DevotUITests/Tests'

// Every test method of the XCUITest bundle, as `Class/testMethod`.
function uiTests(): string[] {
  return readdirSync(tests)
    .filter((file) => file.endsWith('.swift'))
    .flatMap((file) => {
      const source = readFileSync(join(tests, file), 'utf8')
      const classes = [...source.matchAll(/^(?:final )?class (\w+): XCTestCase/gm)]
      return classes.flatMap((match, i) => {
        const body = source.slice(match.index, classes[i + 1]?.index)
        return [...body.matchAll(/^ {4}func (test\w+)\(/gm)].map((m) => `${match[1]}/${m[1]}`)
      })
    })
}

function shardsOf(test: string): string[] {
  const listed = Object.entries(SHARDS)
    .filter(([, entries]) =>
      entries.some((entry) => test === entry || test.startsWith(`${entry}/`)),
    )
    .map(([name]) => name)
  return listed.length ? listed : [REST]
}

it('runs every iPhone UI test in exactly one shard', () => {
  const all = uiTests()
  expect(all.length).toBeGreaterThan(10)
  expect(all.filter((test) => shardsOf(test).length !== 1)).toEqual([])
})

it('lists only tests that exist, each once, and leaves the rest shard something to run', () => {
  const all = uiTests()
  const entries = Object.values(SHARDS).flat()
  const missing = entries.filter(
    (entry) => !all.some((test) => test === entry || test.startsWith(`${entry}/`)),
  )
  expect(missing).toEqual([])
  expect(new Set(entries).size).toBe(entries.length)
  expect(Object.keys(SHARDS)).not.toContain(REST)
  expect(all.filter((test) => shardsOf(test)[0] === REST).length).toBeGreaterThan(0)
})

it('selects a listed shard by its tests and the rest shard by skipping every listed one', () => {
  expect(selection(SMOKE)).toEqual(
    (SHARDS[SMOKE] ?? []).map((test) => `-only-testing:DevotUITests/${test}`),
  )
  const rest = selection(REST)
  expect(rest).toHaveLength(Object.values(SHARDS).flat().length)
  expect(rest.every((arg) => arg.startsWith('-skip-testing:DevotUITests/'))).toBe(true)
  expect(() => selection('nope')).toThrow('E_UI_SHARD_UNKNOWN shard=nope')
})

it("runs the smoke shard in a pull request's iPhone app build and every shard in a full run's matrix, which never stops the others", () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<
      string,
      {
        env?: Record<string, string>
        strategy: { 'fail-fast': boolean; matrix: { shard: string[] } }
      }
    >
  }
  const strategy = ci.jobs['iphone-ui']!.strategy
  expect(strategy['fail-fast']).toBe(false)
  // A full run tests every shard in the matrix: a job that needs iphone-build starts only once it ends.
  expect(strategy.matrix.shard).toEqual([...Object.keys(SHARDS), REST])
  expect(ci.jobs['iphone-build']!.env?.['DEVOT_UI_SHARD']).toBe(SMOKE)
  // The smoke shard is the one pull requests run: it switches every tab and audits the bar.
  expect(SHARDS[SMOKE]).toContain('TabsTests')
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  expect(workflow).toContain('DEVOT_UI_SHARD: ${{ matrix.shard }}')
  expect(readFileSync('scripts/ci/iphone-ui-tests.sh', 'utf8')).toContain(
    'selection=$(node "$root/scripts/ci/iphone-ui-shards.ts" "$DEVOT_UI_SHARD")',
  )
})
