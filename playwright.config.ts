import { defineConfig, devices } from '@playwright/test'
import { reuseServers, uiPorts } from './tests/support/ports'
import { uiSelection } from './tests/support/ui-selection'
import { uiWebServers } from './tests/support/ui-servers'

const { ui: uiPort, csp: cspPort } = uiPorts(import.meta.dirname, process.env)
const reuseExistingServer = reuseServers(process.env)
const selection = uiSelection(import.meta.dirname, process.env)

export default defineConfig({
  testDir: 'tests',
  ...(selection.testMatch ? { testMatch: selection.testMatch } : {}),
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Leave runner capacity for the server and WebKit's rendering processes.
  workers: Number(process.env['DEVOT_UI_WORKERS'] ?? 2),
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
  // The UI tests' build keeps notes in memory (vite.ui-test.config.ts); see ui-servers.ts for dev mode.
  webServer: uiWebServers(
    import.meta.dirname,
    selection.projects,
    { ui: uiPort, csp: cspPort },
    process.env,
    reuseExistingServer,
  ),
})
