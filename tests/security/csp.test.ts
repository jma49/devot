import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MERMAID_FRAME_SANDBOX } from '../../src/renderer/src/preview/mermaid'

type Csp = Record<string, string>

const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
  app: { security: { csp: Csp; devCsp: Csp } }
}
const csp = config.app.security.csp
const sources = (name: string) => (csp[name] ?? '').split(' ').filter(Boolean)

// Tauri's own IPC endpoint and Sentry's US ingest host (crash reports); the
// only non-'self' connections the UI may open.
const TAURI_IPC = ['ipc:', 'http://ipc.localhost']
const SENTRY_INGEST = 'https://*.ingest.us.sentry.io'
// Where the packaged app serves its pages on macOS and iOS.
const APP_ORIGIN = 'tauri://localhost'

describe('production CSP (tauri.conf.json)', () => {
  it('allows scripts and styles from the app only', () => {
    expect(sources('script-src')).toEqual(["'self'", APP_ORIGIN])
    expect(sources('style-src')).toEqual(["'self'"])
  })

  it("lets the sandboxed diagram frame load its scripts without 'self'", () => {
    // The frame's origin is opaque, and WebKit then matches no tauri: URL to 'self'.
    expect(MERMAID_FRAME_SANDBOX.split(' ')).not.toContain('allow-same-origin')
    const html = readFileSync('src/renderer/mermaid.html', 'utf8')
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
      ([, src]) => new URL(src!, `${APP_ORIGIN}/mermaid.html`).href,
    )
    expect(scripts).not.toEqual([])
    const named = sources('script-src').filter((source) => source !== "'self'")
    const allowed = (script: string) =>
      named.some((source) => script.startsWith(source.endsWith('/') ? source : `${source}/`))
    expect(scripts.filter((script) => !allowed(script))).toEqual([])
  })

  it('keeps the diagram frame from loading images from the web', () => {
    // The frame shows no web images, so a diagram's CSS cannot use it to reach a site.
    const html = readFileSync('src/renderer/mermaid.html', 'utf8')
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1]
    expect(policy).toBe("img-src 'self' data: blob:")
  })

  it('never allows inline code or eval', () => {
    const all = Object.keys(csp).flatMap(sources)
    expect(all).not.toContain("'unsafe-inline'")
    expect(all).not.toContain("'unsafe-eval'")
  })

  it('loads images from the app, data/blob URLs, attachments and https', () => {
    // Images in notes load from the web, as written; plain http stays blocked.
    expect(sources('img-src')).toEqual(["'self'", 'data:', 'blob:', 'devot:', 'https:'])
    expect(config.app.security.devCsp['img-src']).toBe(csp['img-src'])
  })

  it('blocks external resource loads', () => {
    for (const name of ['default-src', 'img-src', 'font-src', 'connect-src']) {
      for (const source of sources(name)) {
        if (TAURI_IPC.includes(source)) continue
        if (name === 'connect-src' && source === SENTRY_INGEST) continue
        if (name === 'img-src' && source === 'https:') continue
        expect(source).not.toMatch(/^(https?:|ws:|wss:|\*)/)
      }
    }
  })

  it('connects only to the app, its IPC and the Sentry ingest host', () => {
    expect(sources('connect-src')).toEqual(["'self'", ...TAURI_IPC, SENTRY_INGEST])
  })

  it('allows https iframes, app pages and plugin frames only, and no objects, base or form targets', () => {
    // 'self' is for the app's own diagram frame, devot-plugin: for plugins' sandboxed frames (ADR 0005); notes can only embed https.
    expect(sources('frame-src')).toEqual(["'self'", 'https:', 'devot-plugin:'])
    expect(config.app.security.devCsp['frame-src']).toBe(csp['frame-src'])
    expect(sources('object-src')).toEqual(["'none'"])
    expect(sources('base-uri')).toEqual(["'none'"])
    expect(sources('form-action')).toEqual(["'none'"])
  })

  it('keeps the dev CSP limited to the local dev server', () => {
    const dev = Object.values(config.app.security.devCsp).join(' ')
    for (const host of dev.match(/\b(?:https?|wss?):\/\/[^\s;]+/g) ?? []) {
      expect(host).toMatch(/^(?:https?|ws):\/\/(?:localhost:5173|ipc\.localhost)$/)
    }
  })
})
