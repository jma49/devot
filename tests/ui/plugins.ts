import { readFileSync } from 'node:fs'
import type { Frame, Page } from '@playwright/test'
import type { TestWindow } from './fixtures'

// Plugins in the UI tests (ADR 0005). The test server answers `/__devot-plugins/<id>/…` as Rust answers `devot-plugin://`
// (src-tauri/src/plugins/serve.rs): the same container and plugin pages from src-tauri/plugin-frame/, under the same policies in
// the page and in its header, and only for an enabled plugin. `plugins_list` lists them as Rust would.

const FRAME_DIR = 'src-tauri/plugin-frame/'
const template = (name: string) => readFileSync(`${FRAME_DIR}${name}`, 'utf8')

export interface TestPlugin {
  manifest: Record<string, unknown> & { id: string }
  /** The main script's text. */
  main: string
  files?: Record<string, string>
  enabled?: boolean
  /** What the user approved; all the manifest asks for by default. */
  granted?: string[]
}

export function testPlugin(
  id: string,
  permissions: string[],
  contributes: Record<string, unknown>,
  main: string,
  more: Partial<TestPlugin> = {},
): TestPlugin {
  return {
    manifest: {
      id,
      name: `Plugin ${id.split('.').pop()}`,
      version: '1.0.0',
      apiVersion: 1,
      main: 'main.js',
      permissions,
      contributes,
    },
    main,
    ...more,
  }
}

function render(page: string, cspFile: string, base: string, main = '') {
  const csp = template(cspFile).replaceAll('{{BASE}}', base)
  const html = template(page)
    .replaceAll('{{CSP}}', csp)
    .replaceAll('{{BASE}}', base)
    .replaceAll('{{MAIN}}', main)
  return { csp, html }
}

const MIME: Record<string, string> = {
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
}

export async function servePlugins(page: Page, plugins: TestPlugin[]): Promise<void> {
  const byId = new Map(plugins.map((p) => [p.manifest.id, p]))
  await page.route('**/__devot-plugins/**', async (route) => {
    const url = new URL(route.request().url())
    const found = /^\/__devot-plugins\/([^/]+)\/(.*)$/.exec(url.pathname)
    const plugin = found && byId.get(found[1]!)
    if (!found || !plugin || plugin.enabled === false)
      return route.fulfill({ status: 404, body: '' })
    const base = `${url.origin}/__devot-plugins/${found[1]}/`
    const rest = found[2]!
    const answer = (body: string, contentType: string, csp = "default-src 'none'") =>
      route.fulfill({
        status: 200,
        body,
        headers: {
          'Content-Type': contentType,
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      })
    if (rest === '') {
      const { html, csp } = render('container.html', 'container.csp', base)
      return answer(html, 'text/html', csp)
    }
    if (rest === '__devot/frame.html') {
      const { html, csp } = render('frame.html', 'frame.csp', base, String(plugin.manifest['main']))
      return answer(html, 'text/html', csp)
    }
    if (rest === '__devot/container.js' || rest === '__devot/runtime.js') {
      return answer(template(rest.slice('__devot/'.length)), 'text/javascript')
    }
    if (rest === '__devot/container.css') return answer(template('container.css'), 'text/css')
    const files: Record<string, string> = {
      [String(plugin.manifest['main'])]: plugin.main,
      ...plugin.files,
    }
    if (Object.hasOwn(files, rest)) {
      return answer(files[rest]!, MIME[rest.split('.').pop() ?? ''] ?? 'application/octet-stream')
    }
    return route.fulfill({ status: 404, body: '' })
  })
  const listed = plugins.map((p) => ({
    manifest: p.manifest,
    enabled: p.enabled ?? true,
    granted: p.granted ?? (p.manifest['permissions'] as string[]),
  }))
  await page.addInitScript((list) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, plugins_list: list }
  }, listed)
}

/** The plugin's own page, inside its container. */
export async function pluginFrame(page: Page, id: string): Promise<Frame> {
  const path = `/__devot-plugins/${id}/__devot/frame.html`
  for (let tries = 0; tries < 100; tries += 1) {
    const frame = page.frames().find((f) => f.url().endsWith(path))
    if (frame && (await frame.evaluate(() => typeof (globalThis as { devot?: unknown }).devot))) {
      return frame
    }
    await page.waitForTimeout(50)
  }
  throw new Error(`no frame for ${id}`)
}

/** Sends a page event as Rust's menu would (`devot://plugin-action`). */
export const pickPluginMenu = (page: Page, action: { kind: string; plugin: string; id: string }) =>
  page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('devot:plugin-action', { detail })),
    action,
  )
