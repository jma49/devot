import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { tempDir } from './temp-dirs'
import { UI_TEST_DIST, uiWebServers } from './ui-servers'

const ports = { ui: 5300, csp: 5301 }
const both = ['webkit', 'webkit-prod-csp'] as const
const commands = (servers: { command: string }[]) => servers.map((server) => server.command)

it('serves both projects one build of the UI tests, made once before the first server', () => {
  const servers = uiWebServers(tempDir('devot-ui-servers-'), both, ports, {}, false)
  expect(commands(servers)).toEqual([
    'pnpm test:ui:build && pnpm vite preview --config vite.ui-test.config.ts --outDir ../../dist-test --port 5300 --strictPort',
    'node scripts/serve-csp.ts dist-test 5301',
  ])
  expect(servers.map((server) => server.url)).toEqual([
    'http://localhost:5300',
    'http://localhost:5301',
  ])
})

it('builds for the production CSP project when it runs alone', () => {
  const servers = uiWebServers(tempDir('devot-ui-servers-'), ['webkit-prod-csp'], ports, {}, false)
  expect(commands(servers)).toEqual([
    'pnpm test:ui:build && node scripts/serve-csp.ts dist-test 5301',
  ])
})

it('serves the webkit project from the dev server on request, and builds only for the CSP project', () => {
  const servers = uiWebServers(
    tempDir('devot-ui-servers-'),
    both,
    ports,
    { DEVOT_UI_SERVER: 'dev' },
    false,
  )
  expect(commands(servers)).toEqual([
    'DEVOT_SENTRY_DSN= pnpm vite --config vite.ui-test.config.ts --port 5300 --strictPort',
    'pnpm test:ui:build && node scripts/serve-csp.ts dist-test 5301',
  ])
})

it('uses a build already made and refuses to start without one', () => {
  const root = tempDir('devot-ui-servers-')
  expect(() => uiWebServers(root, both, ports, { DEVOT_UI_PREBUILT: '1' }, false)).toThrow(
    'E_UI_DIST_MISSING',
  )
  mkdirSync(join(root, UI_TEST_DIST))
  writeFileSync(join(root, UI_TEST_DIST, 'index.html'), '<!doctype html>')
  const servers = uiWebServers(root, both, ports, { DEVOT_UI_PREBUILT: '1' }, false)
  expect(commands(servers).some((command) => command.includes('test:ui:build'))).toBe(false)
})

it('rejects an unknown server mode', () => {
  expect(() =>
    uiWebServers(tempDir('devot-ui-servers-'), both, ports, { DEVOT_UI_SERVER: 'prod' }, false),
  ).toThrow('DEVOT_UI_SERVER')
})
