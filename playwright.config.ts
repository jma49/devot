import { defineConfig, devices } from '@playwright/test'
import { reuseServers, uiPorts } from './tests/support/ports'
import { uiSelection } from './tests/support/ui-selection'

const { ui: uiPort, csp: cspPort } = uiPorts(import.meta.dirname, process.env)
const reuseExistingServer = reuseServers(process.env)
const selection = uiSelection(import.meta.dirname, process.env)

export default defineConfig({
  testDir: 'tests',
  ...(selection.testMatch ? { testMatch: selection.testMatch } : {}),
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Public Linux runners have four cores; keep local runs capped at two.
  workers: Number(process.env['DEVOT_UI_WORKERS'] ?? (process.env['CI'] ? 4 : 2)),
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
  ].filter((project) => selection.projects.some((name) => name === project.name)),
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
  ].filter((_, index) => selection.projects.includes(index === 0 ? 'webkit' : 'webkit-prod-csp')),
})
