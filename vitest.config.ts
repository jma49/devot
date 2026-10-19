import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Capped so a local run leaves the machine usable; DEVOT_TEST_WORKERS
    // raises the cap. CI keeps Vitest's default.
    ...(process.env['CI'] ? {} : { maxWorkers: Number(process.env['DEVOT_TEST_WORKERS'] ?? 3) }),
    // Machine-load lets time budgets skip on an overloaded machine; temp-dirs removes each test file's temporary folders.
    setupFiles: ['tests/support/machine-load.ts', 'tests/support/temp-dirs.setup.ts'],
  },
})
