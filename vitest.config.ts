import { defineConfig } from 'vitest/config'

const include = ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}']
// Benchmarks and real builds: about half the suite's time in a handful of files. `pnpm test` and CI
// run them; `pnpm test:fast` (the pre-push hook) leaves them out.
const slow = ['**/*.bench.test.ts', 'tests/policy/source-maps.test.ts']

export default defineConfig({
  test: {
    environment: 'node',
    // Capped so a local run leaves the machine usable; DEVOT_TEST_WORKERS
    // raises the cap. CI keeps Vitest's default.
    ...(process.env['CI'] ? {} : { maxWorkers: Number(process.env['DEVOT_TEST_WORKERS'] ?? 3) }),
    // Node's own localStorage warns in every worker; tests that need one install it (tests/support/local-storage.ts).
    execArgv: ['--no-experimental-webstorage'],
    // Logs from passing tests are expected warnings; only a failing test's output is worth reading.
    silent: 'passed-only',
    // Machine-load lets time budgets skip on an overloaded machine; temp-dirs removes each test file's temporary folders.
    setupFiles: ['tests/support/machine-load.ts', 'tests/support/temp-dirs.setup.ts'],
    projects: [
      { extends: true, test: { name: 'fast', include, exclude: slow } },
      { extends: true, test: { name: 'slow', include: slow } },
    ],
  },
})
