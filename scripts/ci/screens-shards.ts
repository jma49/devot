import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: splits the screens package's XCTests (src-tauri/apple/DevotScreens/Tests) between the
// `ios-app` jobs of .github/workflows/ci.yml, which each boot a simulator and build the package
// (about 6 minutes) before the first test runs. Classes go to the part with the fewest tests so
// far; the last part runs every class the others do not name, so a class this misses still runs.
// `node scripts/ci/screens-shards.ts <part>/<parts>` prints that part's xcodebuild test selection.

const TESTS = 'src-tauri/apple/DevotScreens/Tests/DevotScreensTests'
const TARGET = 'DevotScreensTests'

/** Each test class with the number of its tests, by name. */
export function testClasses(dir: string): [name: string, tests: number][] {
  const found: [string, number][] = []
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.swift')) continue
    const source = readFileSync(join(dir, entry), 'utf8')
    const classes = [...source.matchAll(/^(?:final )?class (\w+): XCTestCase/gm)]
    classes.forEach((match, i) => {
      const body = source.slice(match.index, classes[i + 1]?.index)
      found.push([match[1] ?? '', [...body.matchAll(/^\s+func test\w+\(/gm)].length])
    })
  }
  return found.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

export function parts(classes: readonly [string, number][], count: number): string[][] {
  const split: { names: string[]; tests: number }[] = Array.from({ length: count }, () => ({
    names: [],
    tests: 0,
  }))
  for (const [name, tests] of classes.toSorted(([, a], [, b]) => b - a)) {
    const least = split.reduce((a, b) => (b.tests < a.tests ? b : a))
    least.names.push(name)
    least.tests += tests
  }
  return split.map((part) => part.names.toSorted())
}

export function selection(part: string, classes: readonly [string, number][]): string[] {
  const match = /^(\d+)\/(\d+)$/.exec(part)
  const [index, count] = [Number(match?.[1]), Number(match?.[2])]
  if (!match || index < 1 || index > count) throw new Error(`E_SCREENS_PART part=${part}`)
  if (count === 1) return []
  const split = parts(classes, count)
  if (index < count) return (split[index - 1] ?? []).map((n) => `-only-testing:${TARGET}/${n}`)
  return split
    .slice(0, -1)
    .flat()
    .map((n) => `-skip-testing:${TARGET}/${n}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../../..')
  console.log(selection(process.argv[2] ?? '', testClasses(join(root, TESTS))).join(' '))
}
