import { defineConfig } from 'vitest/config'
import { budgetScale } from './tests/support/budget.ts'
import { testSelection } from './tests/support/test-selection.ts'

const include = ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}']
// Benchmarks and real builds: about half the suite's time in a few dozen files. `pnpm test` and CI
// run the builds after the rest, then the benchmarks, so a timing never shares the CPU with a
// build; `pnpm test:fast` (the pre-push hook) leaves both out.
const builds = ['**/*.build.test.ts']
const benches = ['**/*.bench.test.ts']
const ci = Boolean(process.env['CI'])
// Vitest's time limits are sized for a developer's Mac, like the budgets: a hosted runner and a
// slower machine get the budgets' factor (tests/support/budget.ts). On CI two tests ran out of the
// defaults under load.
const timeScale = budgetScale(process.env)
// A CI shard runs exactly the files scripts/ci/vitest-plan.ts gave it, each in its usual project.
const selected = testSelection(import.meta.dirname, process.env)
const isBuild = (file: string) => file.endsWith('.build.test.ts')
const isBench = (file: string) => file.endsWith('.bench.test.ts')
const pick = (patterns: string[], kind: (file: string) => boolean) =>
  selected ? selected.filter(kind) : patterns

export default defineConfig({
  define: { DEVOT_SPIKES: 'false' },
  test: {
    environment: 'node',
    testTimeout: 5000 * timeScale,
    hookTimeout: 10_000 * timeScale,
    // Capped so a local run leaves the machine usable; DEVOT_TEST_WORKERS
    // raises the cap. CI keeps Vitest's default.
    ...(ci ? {} : { maxWorkers: Number(process.env['DEVOT_TEST_WORKERS'] ?? 3) }),
    // Every time check's measurement, for the budgets' evidence (tests/support/budget-report.ts), and
    // each file's time, for the CI shard plan (scripts/ci/vitest-timings.ts).
    ...(process.env['GITHUB_ACTIONS'] === 'true'
      ? {
          reporters: ['default', 'github-actions', './tests/support/budget-report.ts', 'json'],
          outputFile: { json: 'test-results/vitest-report.json' },
        }
      : {}),
    // Node's own localStorage warns in every worker; tests that need one install it (tests/support/local-storage.ts).
    execArgv: ['--no-experimental-webstorage'],
    // Logs from passing tests are expected warnings; only a failing test's output is worth reading.
    silent: 'passed-only',
    // Machine-load lets time budgets skip on an overloaded machine; temp-dirs removes each test file's temporary folders.
    setupFiles: ['tests/support/machine-load.ts', 'tests/support/temp-dirs.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'fast',
          include: pick(include, (file) => !isBuild(file) && !isBench(file)),
          exclude: [...builds, ...benches],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: 'build', include: pick(builds, isBuild), sequence: { groupOrder: 1 } },
      },
      {
        extends: true,
        test: { name: 'slow', include: pick(benches, isBench), sequence: { groupOrder: 2 } },
      },
    ],
  },
})
