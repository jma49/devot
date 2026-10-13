import { defineConfig, devices } from '@playwright/test'

// UI integration tests: the real UI in Playwright's WebKit build, with Tauri's
// IPC mocked. They cannot reach the Rust side; full-app tests come later.

// Ports can be moved so that two checkouts can run their suites side by side.
const uiPort = Number(process.env['DEVOT_UI_PORT'] ?? 5174)
const cspPort = Number(process.env['DEVOT_CSP_PORT'] ?? 5175)

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Two workers on CI: the hosted runner has two cores. Two locally too, so a
  // local run leaves the machine usable; DEVOT_UI_WORKERS (or --workers)
  // raises it.
  workers: process.env['CI'] ? 2 : Number(process.env['DEVOT_UI_WORKERS'] ?? 2),
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: `http://localhost:${uiPort}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'webkit', testDir: 'tests/ui', use: { ...devices['Desktop Safari'] } },
    // The built UI under the production CSP, which `pnpm dev` relaxes.
    {
      name: 'webkit-prod-csp',
      testDir: 'tests/ui-csp',
      use: { ...devices['Desktop Safari'], baseURL: `http://localhost:${cspPort}` },
    },
  ],
  webServer: [
    {
      // No DSN in tests: nothing may reach Sentry. The UI tests' build keeps
      // notes in memory (vite.ui-test.config.ts).
      command: `DEVOT_SENTRY_DSN= pnpm vite --config vite.ui-test.config.ts --port ${uiPort} --strictPort`,
      url: `http://localhost:${uiPort}`,
      reuseExistingServer: !process.env['CI'],
    },
    {
      command: `DEVOT_SENTRY_DSN= pnpm vite build --config vite.ui-test.config.ts --outDir ../../dist-test --emptyOutDir && node scripts/serve-csp.ts dist-test ${cspPort}`,
      url: `http://localhost:${cspPort}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
})
