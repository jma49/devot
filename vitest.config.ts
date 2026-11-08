import { defineConfig } from 'vitest/config'

const include = ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}']
// Benchmarks and real builds: about half the suite's time in a few dozen files. `pnpm test` and CI
// run the builds after the rest, then the benchmarks, so a timing never shares the CPU with a
// build; `pnpm test:fast` (the pre-push hook) leaves both out.
const builds = ['**/*.build.test.ts']
const benches = ['**/*.bench.test.ts']
const ci = Boolean(process.env['CI'])

export default defineConfig({
  define: { DEVOT_SPIKES: 'false' },
  test: {
    environment: 'node',
    // Capped so a local run leaves the machine usable; DEVOT_TEST_WORKERS
    // raises the cap. CI keeps Vitest's default.
    ...(ci ? {} : { maxWorkers: Number(process.env['DEVOT_TEST_WORKERS'] ?? 3) }),
    // Every time check's measurement, for the budgets' evidence (tests/support/budget-report.ts).
    ...(process.env['GITHUB_ACTIONS'] === 'true'
      ? { reporters: ['default', 'github-actions', './tests/support/budget-report.ts'] }
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
          include,
          exclude: [...builds, ...benches],
          sequence: { groupOrder: 0 },
        },
      },
      { extends: true, test: { name: 'build', include: builds, sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: 'slow', include: benches, sequence: { groupOrder: 2 } } },
    ],
  },
})
