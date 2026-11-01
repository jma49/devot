import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ASSETS, assetResponse } from '../../licence/src/assets'
import { COLORS, DOVE } from '../../licence/src/brand'
import type { LicenceCode } from '../../licence/src/errors'
import { MESSAGES } from '../../licence/src/messages'
import {
  donePage,
  errorPage,
  pendingPage,
  PENDING_CHECKS,
  PENDING_RELOAD_SECONDS,
  resendPage,
  resentPage,
} from '../../licence/src/pages'

const KEY = 'devot1.eyJpZCI6IkFBQSJ9.c2lnbmF0dXJl'
const HOSTILE = `devot1.<script>alert("x")</script>&'+/=?#.sig`
const CODES = Object.keys(MESSAGES.errors) as LicenceCode[]
const SESSION = 'cs_test_a1B2'

const pages = (): [string, Response][] => [
  ['done', donePage(KEY)],
  ['pending', pendingPage(SESSION, 0)],
  ['pending, stopped', pendingPage(SESSION, PENDING_CHECKS)],
  ['resend', resendPage()],
  ['resent', resentPage()],
  ...CODES.map((code): [string, Response] => [code, errorPage(code, 500)]),
]

describe('every page', () => {
  it.each(pages())('%s carries the strict headers', (_name, response) => {
    const csp = response.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).not.toMatch(/unsafe-|\*|https?:/)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  })

  it.each(pages())(
    '%s has no inline script or style and loads nothing from elsewhere',
    async (_n, r) => {
      const html = await r.text()
      expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i)
      for (const [, attrs] of html.matchAll(/<script([^>]*)>/g)) {
        expect(attrs).toContain(`src="${ASSETS.copy}"`)
      }
      expect([...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual([
        ASSETS.style,
      ])
      expect(html).not.toMatch(/<img|<iframe|src="https?:/)
      const external = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1])
      expect(new Set(external)).toEqual(new Set([MESSAGES.siteUrl]))
    },
  )

  it.each(pages())('%s shows the dove and the wordmark', async (_name, response) => {
    const html = await response.text()
    expect(html).toContain(`d="${DOVE.smallPath}"`)
    expect(html).toContain(`<span>${MESSAGES.product}</span>`)
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">')
  })
})

describe('/done', () => {
  it('shows the key, Copy, Open in Devot, the manual way, the email and the resend link', async () => {
    const html = await donePage(KEY).text()
    expect(html).toContain(
      `<pre class="key" id="licence-key" aria-labelledby="key-label">${KEY}</pre>`,
    )
    expect(html).toContain(`href="devot://licence?key=${encodeURIComponent(KEY)}"`)
    expect(html).toContain(`data-copy="licence-key"`)
    expect(html).toContain(`<script src="${ASSETS.copy}" defer></script>`)
    for (const text of [
      MESSAGES.doneTitle,
      MESSAGES.open,
      MESSAGES.copy,
      MESSAGES.covers,
      MESSAGES.manual.replaceAll('>', '&gt;'),
      MESSAGES.doneMailed,
    ]) {
      expect(html).toContain(text)
    }
    expect(html).toContain(`<a href="/resend">${MESSAGES.resendLink}</a>`)
  })

  it('escapes the key everywhere and URL-encodes it in the deep link', async () => {
    const html = await donePage(HOSTILE).text()
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain(`'+/`)
    expect(html).toContain(
      'devot1.&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;+/=?#.sig',
    )
    const href = /href="(devot:[^"]+)"/.exec(html)?.[1] ?? ''
    expect(href).toBe(`devot://licence?key=${encodeURIComponent(HOSTILE)}`.replace(/'/g, '&#39;'))
    expect(new URL(href.replace(/&#39;/g, "'")).searchParams.get('key')).toBe(HOSTILE)
  })
})

it('the waiting page answers 202 and reloads itself with the next check count, with no key', async () => {
  const response = pendingPage(SESSION, 0)
  expect(response.status).toBe(202)
  const html = await response.text()
  expect(html).toContain(
    `<meta http-equiv="refresh" content="${PENDING_RELOAD_SECONDS};url=/done?session_id=${SESSION}&amp;check=1">`,
  )
  expect(html).toContain(MESSAGES.pendingBody)
  expect(html).toContain(MESSAGES.pendingReload)
  // WCAG 2.2.1 (F41): the reload has a control that stops it.
  expect(html).toContain(
    `<a href="/done?session_id=${SESSION}&amp;check=${PENDING_CHECKS}">${MESSAGES.pendingStop}</a>`,
  )
  expect(html).not.toMatch(/devot1|<script/)
})

it('the waiting page stops reloading after a bounded number of checks', async () => {
  expect(await pendingPage(SESSION, PENDING_CHECKS - 1).text()).toContain(
    `check=${PENDING_CHECKS}">`,
  )
  const html = await pendingPage(SESSION, PENDING_CHECKS).text()
  expect(pendingPage(SESSION, PENDING_CHECKS).status).toBe(202)
  expect(html).not.toContain('http-equiv="refresh"')
  expect(html).not.toContain('class="spinner"')
  expect(html).not.toContain(MESSAGES.pendingReload)
  expect(html).toContain(MESSAGES.pendingStopped)
  expect(html).toContain(`<a href="/done?session_id=${SESSION}">${MESSAGES.pendingCheckAgain}</a>`)
  expect(await pendingPage(SESSION, 10 ** 9).text()).not.toContain('http-equiv="refresh"')
})

it('the resend form posts an address, and its answer says nothing about the address', async () => {
  const form = await resendPage().text()
  expect(form).toContain('<form method="post" action="/resend" class="form">')
  expect(form).toContain('<input id="email" type="email" name="email" required maxlength="254"')
  expect(form).toContain(`<label for="email">${MESSAGES.resendField}</label>`)
  const answer = await resentPage().text()
  expect(answer).toContain(MESSAGES.resentBody)
  expect(answer).not.toMatch(/@|<form/)
})

it.each(CODES)('the error page for %s gives its sentence and code, nothing more', async (code) => {
  const response = errorPage(code, 418)
  expect(response.status).toBe(418)
  const html = await response.text()
  expect(html).toContain(MESSAGES.errors[code])
  expect(html).toContain(`${MESSAGES.errorCode}: <code>${code}</code>`)
  expect(html).not.toMatch(
    /at \w+ \(|Error:|@|https?:\/\/(?!devot\.online|www\.w3\.org\/2000\/svg)/,
  )
})

describe('assets', () => {
  it('serves the stylesheet and the copy script with their types, and nothing else', async () => {
    const css = assetResponse(ASSETS.style, 'GET')
    expect(css?.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(css?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const style = (await css?.text()) ?? ''
    expect(style).toContain('@media (prefers-color-scheme:dark)')
    expect(style).not.toMatch(/@import|url\(|@font-face/)
    const js = assetResponse(ASSETS.copy, 'GET')
    expect(js?.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(await assetResponse(ASSETS.copy, 'HEAD')?.text()).toBe('')
    expect(assetResponse(ASSETS.copy, 'POST')).toBeUndefined()
    expect(assetResponse('/assets/other.js', 'GET')).toBeUndefined()
    expect(assetResponse('/assets/__proto__', 'GET')).toBeUndefined()
  })

  it('the stylesheet uses every theme colour, in light and in dark', async () => {
    const style = (await assetResponse(ASSETS.style, 'GET')?.text()) ?? ''
    for (const theme of [COLORS.light, COLORS.dark]) {
      for (const [name, value] of Object.entries(theme)) {
        expect(style).toContain(`--color-${name}:${value};`)
      }
    }
    for (const color of DOVE.ink.dark) expect(style).toContain(`stop-color:${color}`)
  })
})

describe('the copy script', () => {
  async function run(clipboard?: { writeText: (text: string) => Promise<void> }) {
    const button = {
      hidden: true,
      dataset: { copy: 'licence-key', status: 'copy-status', copied: 'Copied', failed: 'Failed' },
      click: async () => {},
      addEventListener(_: string, handler: () => Promise<void>) {
        this.click = handler
      },
    }
    const nodes: Record<string, { textContent: string }> = {
      'licence-key': { textContent: `  ${KEY}\n` },
      'copy-status': { textContent: '' },
    }
    const script = (await assetResponse(ASSETS.copy, 'GET')?.text()) ?? ''
    runInNewContext(script, {
      document: { querySelectorAll: () => [button], getElementById: (id: string) => nodes[id] },
      navigator: { clipboard },
    })
    return { button, status: nodes['copy-status'] }
  }

  it('copies the key and says so', async () => {
    const copied: string[] = []
    const { button, status } = await run({ writeText: async (text) => void copied.push(text) })
    expect(button.hidden).toBe(false)
    await button.click()
    expect(copied).toEqual([KEY])
    expect(status?.textContent).toBe('Copied')
  })

  it('says when copying fails, and stays hidden without a clipboard', async () => {
    const failing = await run({ writeText: () => Promise.reject(new Error('denied')) })
    await failing.button.click()
    expect(failing.status?.textContent).toBe('Failed')
    expect((await run()).button.hidden).toBe(true)
  })
})

describe('brand', () => {
  const tokens = readFileSync('src/renderer/src/theme/tokens.css', 'utf8')
  const block = (start: string) => {
    const from = tokens.indexOf(start)
    return tokens.slice(from, tokens.indexOf('\n}', from))
  }
  const value = (css: string, name: string) =>
    new RegExp(`--color-${name}: ([^;]+);`)
      .exec(css)?.[1]
      ?.replace(/^var\(--[a-z-]+, (.+)\)$/, '$1')

  it.each([
    ['light', ':root {', COLORS.light],
    ['dark', '@media (prefers-color-scheme: dark) {', COLORS.dark],
  ] as const)('the %s colours are the system theme tokens', (_name, start, colors) => {
    const css = block(start)
    for (const [name, color] of Object.entries(colors)) {
      expect([name, value(css, name)]).toEqual([name, color])
    }
  })
})
