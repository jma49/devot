import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDurations } from './durations.ts'

export interface VitestShard {
  shard: number
  shards: number
  files: string[]
}

export interface VitestPlan {
  mode: 'full' | 'targeted' | 'none'
  /** Why the plan runs everything, or undefined for a targeted plan. */
  reason?: string
  files: string[]
  matrix: { include: VitestShard[] }
}

// Recorded work sums each file's own time; four workers on a four-core runner run about 180 s of it
// in a minute or so, next to a setup of about 40 s. The whole suite records about 700 s.
export const TARGET_SHARD_WORK_MS = 180_000
// The account runs 20 jobs at a time, and a full run's UI shards take 15 of them.
export const MAX_SHARDS = 4

// Paths a pull request may change and still run only the tests that reach them. Anything else
// (configuration, the lockfile, test support and fixtures, CI, Rust, unknown paths) runs every test.
const TARGETABLE = [
  /^src\//,
  /^tests\/(?!support\/|fixtures\/)/,
  /^scripts\/(?!ci\/vitest-)/,
  /^(?:relay|licence|share|clipper|plugin-kit|plugins|design|docs)\//,
  /\.md$/,
]
const TEST_FILE = /\.test\.tsx?$/

/** Files whose code reads or runs other files, so their tests depend on more than their imports. */
export const READS_FILES =
  /\b(?:readFileSync|readFile|readdirSync|readdir|opendirSync|globSync|glob|existsSync|statSync|lstatSync|createReadStream|execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(|import\.meta\.glob\b|from\s+['"](?:node:)?child_process['"]/

export function fullReason(changed: string[], exists: (file: string) => boolean) {
  if (!changed.length) return 'no changed files'
  for (const file of changed) {
    if (!TARGETABLE.some((pattern) => pattern.test(file))) return `${file} changes every test`
    if (!exists(file) && !file.endsWith('.md')) return `${file} was removed or renamed`
  }
  return undefined
}

/** Splits `files` into shards of about TARGET_SHARD_WORK_MS of recorded work, slowest first. */
export function shardFiles(files: string[], durations: Record<string, number>): VitestShard[] {
  if (!files.length) return []
  const measured = files
    .map((file) => durations[file])
    .filter((ms): ms is number => ms !== undefined && Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b)
  // An unknown file costs the median known file; without any, every file costs the same.
  const fallback = measured.length ? measured[measured.length >> 1]! : 1
  const cost = (file: string) => {
    const ms = durations[file]
    return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : fallback
  }
  const total = files.reduce((ms, file) => ms + cost(file), 0)
  const shards = measured.length
    ? Math.min(MAX_SHARDS, files.length, Math.max(1, Math.ceil(total / TARGET_SHARD_WORK_MS)))
    : Math.min(MAX_SHARDS, files.length)
  const groups = Array.from({ length: shards }, () => ({ files: [] as string[], work: 0 }))
  const ordered = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))
  for (const file of ordered) {
    const lightest = groups.reduce((min, group) => (group.work < min.work ? group : min))
    lightest.files.push(file)
    lightest.work += cost(file)
  }
  return groups.map((group, index) => ({
    shard: index + 1,
    shards,
    files: group.files.sort(),
  }))
}

export interface PlanInput {
  changed: string[]
  tests: string[]
  forceFull?: boolean
  exists?: (file: string) => boolean
  /** The tests that import a changed file or a file that reads other files, by Vitest's graph. */
  related?: (changed: string[]) => Promise<string[]> | string[]
  durations?: Record<string, number>
}

export async function planVitest(input: PlanInput): Promise<VitestPlan> {
  const tests = [...new Set(input.tests)].sort()
  const changed = [...new Set(input.changed.filter(Boolean))]
  const reason = input.forceFull
    ? 'a full run'
    : fullReason(changed, input.exists ?? ((file) => existsSync(file)))
  let files = tests
  if (reason === undefined) {
    const selected = new Set((await input.related?.(changed)) ?? tests)
    for (const file of changed) if (TEST_FILE.test(file)) selected.add(file)
    files = tests.filter((file) => selected.has(file))
  }
  const include = shardFiles(files, input.durations ?? {})
  return {
    mode: reason !== undefined ? 'full' : files.length ? 'targeted' : 'none',
    ...(reason !== undefined ? { reason } : {}),
    files,
    // GitHub validates the matrix even when the job is skipped.
    matrix: { include: include.length ? include : [{ shard: 1, shards: 1, files: [] }] },
  }
}

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.mjs'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file && !file.startsWith('node_modules/'))
}

// Files that read only what their callers make at run time (a test's database, the relay's data
// folder), never the repository's own files, so their many tests need not run for every change.
export const RUNTIME_READERS = ['tests/support/sqlite-adapter.ts', 'relay/src/node/server.ts']

// The files outside src/ whose code reads or runs other files: the app's own code reads none of the
// repository, and the renderer's file calls go to Tauri.
function readers(root: string): string[] {
  return trackedSources().filter(
    (file) =>
      !file.startsWith('src/') &&
      !RUNTIME_READERS.includes(file) &&
      READS_FILES.test(readFileSync(resolve(root, file), 'utf8')),
  )
}

/** Every test file, and when `changed` is given, the tests that reach it or a file that reads files. */
async function vitestGraph(changed?: string[]) {
  const { createVitest } = await import('vitest/node')
  const root = process.cwd()
  const reading = changed ? readers(root) : []
  const relative = (id: string) => id.slice(root.length + 1)
  const vitest = await createVitest(
    {
      watch: false,
      ...(changed ? { related: [...changed, ...reading].map((file) => resolve(root, file)) } : {}),
    },
    {},
    { stdout: process.stderr },
  )
  try {
    const tests = (await vitest.globTestSpecifications()).map((spec) => relative(spec.moduleId))
    const related = changed
      ? (await vitest.getRelevantTestSpecifications()).map((spec) => relative(spec.moduleId))
      : tests
    return { tests, related, readers: reading }
  } finally {
    await vitest.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const forceFull = process.argv.includes('--full')
  const changed = forceFull ? [] : readFileSync(0, 'utf8').split('\n').filter(Boolean)
  const durations = readDurations(
    process.env['DEVOT_VITEST_DURATIONS'],
    fileURLToPath(new URL('./vitest-durations.json', import.meta.url)),
  )
  const reason = forceFull ? 'a full run' : fullReason(changed, (file) => existsSync(file))
  // Vitest's graph is read only for a targeted plan: a full one needs only the list of tests.
  const graph = await vitestGraph(reason === undefined ? changed : undefined)
  if (!graph.tests.length) throw new Error('E_VITEST_TESTS_MISSING')
  const plan = await planVitest({
    changed,
    tests: graph.tests,
    forceFull,
    related: () => graph.related,
    durations,
  })
  console.log(`unit=${plan.mode !== 'none'}`)
  console.log(`unit_matrix=${JSON.stringify(plan.matrix)}`)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) {
    const work = (files: string[]) =>
      (files.reduce((ms, file) => ms + (durations[file] ?? 0), 0) / 1000).toFixed(1)
    appendFileSync(
      summary,
      [
        '### Vitest selection',
        '',
        `Mode: **${plan.mode}**${plan.reason ? ` (${plan.reason})` : ''}; selected **${plan.files.length}/${graph.tests.length}** test files, ${graph.readers.length} files that read other files always run their tests.`,
        '',
        '| Shard | Files | Recorded work (s) | Unmeasured files |',
        '| --- | --- | --- | --- |',
        ...plan.matrix.include.map(
          (job) =>
            `| ${job.shard}/${job.shards} | ${job.files.length} | ${work(job.files)} | ${job.files.filter((file) => !durations[file]).length} |`,
        ),
        '',
      ].join('\n'),
    )
  }
}
