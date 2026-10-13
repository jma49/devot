import { defineConfig } from 'vitest/config'

// Vitest runs `*.test.ts(x)`; Playwright UI tests are `tests/ui/*.spec.ts`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Capped so a local run leaves the machine usable; DEVOT_TEST_WORKERS
    // raises the cap. CI keeps Vitest's default.
    ...(process.env['CI'] ? {} : { maxWorkers: Number(process.env['DEVOT_TEST_WORKERS'] ?? 3) }),
    // Lets time budgets skip on an overloaded local machine (tests/support/budget.ts).
    // and removes the temporary folders each test file made (tests/support/temp-dirs.ts).
    setupFiles: ['tests/support/machine-load.ts', 'tests/support/temp-dirs.setup.ts'],
  },
})
