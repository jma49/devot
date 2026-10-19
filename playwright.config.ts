import { defineConfig, devices } from '@playwright/test'
import { reuseServers, uiPorts } from './tests/support/ports'

// UI tests: the real UI in Playwright's WebKit with Tauri's IPC mocked; they cannot reach Rust.

// Ports derive from the checkout folder so checkouts run side by side (DEVOT_UI_PORT, DEVOT_CSP_PORT
// override). A server already answering on a port fails the run, as it may be another checkout's or an
// old build; DEVOT_REUSE_SERVERS=1 reuses them (and skips the production-CSP build).
const { ui: uiPort, csp: cspPort } = uiPorts(import.meta.dirname, process.env)
const reuseExistingServer = reuseServers(process.env)

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Two workers: the hosted CI runner has two cores, and a local run stays usable.
  // DEVOT_UI_WORKERS or --workers raises it.
  workers: process.env['CI'] ? 2 : Number(process.env['DEVOT_UI_WORKERS'] ?? 2),
  reporter: process.env['CI'] ? 'github' : 'list',
  // Reduce Motion is on so sliding panes never race an assertion; motion tests turn it off with `page.emulateMedia`.
  use: {
    baseURL: `http://localhost:${uiPort}`,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
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
      reuseExistingServer,
    },
    {
      command: `DEVOT_SENTRY_DSN= pnpm vite build --config vite.ui-test.config.ts --outDir ../../dist-test --emptyOutDir && node scripts/serve-csp.ts dist-test ${cspPort}`,
      url: `http://localhost:${cspPort}`,
      reuseExistingServer,
      timeout: 120_000,
    },
  ],
})
