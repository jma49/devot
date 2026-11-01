import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Suite {
  suites?: Suite[]
  specs?: {
    file: string
    tests: { results: { duration: number; status: string }[] }[]
  }[]
}

export function uiDurations(reports: { suites: Suite[] }[]): Record<string, number> {
  const durations = new Map<string, number>()
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file.startsWith('tests/') ? spec.file : `tests/${spec.file}`
      if (!/^tests\/ui(?:-csp)?\/[^\n]+\.spec\.ts$/.test(file)) continue
      for (const test of spec.tests) {
        for (const result of test.results) {
          if (result.status === 'skipped') continue
          if (!Number.isFinite(result.duration) || result.duration < 0)
            throw new Error('E_UI_DURATION_INVALID')
          durations.set(file, (durations.get(file) ?? 0) + result.duration)
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const report of reports) for (const suite of report.suites) visit(suite)
  return Object.fromEntries([...durations].sort(([a], [b]) => a.localeCompare(b)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...inputs] = process.argv.slice(2)
  if (!output || !inputs.length) throw new Error('E_UI_TIMINGS_ARGUMENTS')
  const durations = uiDurations(inputs.map((file) => JSON.parse(readFileSync(file, 'utf8'))))
  if (!Object.keys(durations).length) throw new Error('E_UI_TIMINGS_EMPTY')
  writeFileSync(output, `${JSON.stringify(durations, null, 2)}\n`)
}
