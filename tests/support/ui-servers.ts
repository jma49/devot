import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UiPorts } from './ports'

type UiProject = 'webkit' | 'webkit-prod-csp'

/** Where `pnpm test:ui:build` writes the UI tests' build, relative to the repository. */
export const UI_TEST_DIST = 'dist-test'

/**
 * The UI tests' servers (playwright.config.ts). By default both projects load one build of the
 * UI tests' bundle, made before the first server starts; `DEVOT_UI_SERVER=dev` serves the
 * `webkit` project from Vite's dev server instead, and `DEVOT_UI_PREBUILT=1` uses a build
 * already in dist-test/ (CI builds it once for every shard).
 */
export function uiWebServers(
  root: string,
  projects: readonly UiProject[],
  ports: UiPorts,
  env: Readonly<Record<string, string | undefined>>,
  reuseExistingServer: boolean,
) {
  const mode = env['DEVOT_UI_SERVER'] || 'build'
  if (mode !== 'build' && mode !== 'dev') throw new Error('DEVOT_UI_SERVER must be build or dev')
  const prebuilt = env['DEVOT_UI_PREBUILT'] === '1'
  if (prebuilt && !existsSync(join(root, UI_TEST_DIST, 'index.html'))) {
    throw new Error('E_UI_DIST_MISSING: DEVOT_UI_PREBUILT=1 needs pnpm test:ui:build first')
  }
  const servers: { port: number; command: string; built: boolean }[] = []
  if (projects.includes('webkit')) {
    servers.push(
      mode === 'dev'
        ? {
            port: ports.ui,
            // No DSN in tests: nothing may reach Sentry.
            command: `DEVOT_SENTRY_DSN= pnpm vite --config vite.ui-test.config.ts --port ${ports.ui} --strictPort`,
            built: false,
          }
        : {
            port: ports.ui,
            command: `pnpm vite preview --config vite.ui-test.config.ts --outDir ../../${UI_TEST_DIST} --port ${ports.ui} --strictPort`,
            built: true,
          },
    )
  }
  if (projects.includes('webkit-prod-csp')) {
    servers.push({
      port: ports.csp,
      command: `node scripts/serve-csp.ts ${UI_TEST_DIST} ${ports.csp}`,
      built: true,
    })
  }
  // Playwright starts its web servers one after another, each once the one before answers,
  // so the first that serves the build makes it for both.
  let build = !prebuilt
  return servers.map(({ port, command, built }) => {
    const first = build && built
    if (first) build = false
    return {
      command: first ? `pnpm test:ui:build && ${command}` : command,
      url: `http://localhost:${port}`,
      reuseExistingServer,
      timeout: first ? 180_000 : 60_000,
    }
  })
}
