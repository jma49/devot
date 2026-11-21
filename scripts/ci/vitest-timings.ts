import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Report {
  testResults?: { name: string; startTime?: number; endTime?: number }[]
}

/**
 * Each test file's time from Vitest's JSON reports, from its start to its end in its worker, over
 * `previous`: a file the reports leave out keeps its old time while it still exists.
 */
export function vitestDurations(
  root: string,
  reports: Report[],
  previous: Record<string, number> = {},
  exists: (file: string) => boolean = (file) => existsSync(resolve(root, file)),
): Record<string, number> {
  const durations = new Map<string, number>()
  for (const [file, ms] of Object.entries(previous)) {
    if (Number.isFinite(ms) && ms > 0 && exists(file)) durations.set(file, ms)
  }
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      const file = relative(root, resolve(root, result.name)).replaceAll('\\', '/')
      if (file.startsWith('..') || !/\.test\.tsx?$/.test(file)) continue
      const { startTime, endTime } = result
      if (startTime === undefined || endTime === undefined) continue
      const ms = endTime - startTime
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`E_VITEST_DURATION_INVALID ${file}`)
      durations.set(file, Math.max(1, Math.round(ms)))
    }
  }
  return Object.fromEntries([...durations].sort(([a], [b]) => a.localeCompare(b)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...inputs] = process.argv.slice(2)
  if (!output || !inputs.length) throw new Error('E_VITEST_TIMINGS_ARGUMENTS')
  const previous = existsSync(output)
    ? (JSON.parse(readFileSync(output, 'utf8')) as Record<string, number>)
    : {}
  const durations = vitestDurations(
    process.cwd(),
    inputs.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Report),
    previous,
  )
  if (!Object.keys(durations).length) throw new Error('E_VITEST_TIMINGS_EMPTY')
  writeFileSync(output, `${JSON.stringify(durations, null, 2)}\n`)
}
