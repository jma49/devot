import { ASSETS } from './assets.ts'
import { doveSvg } from './brand.ts'
import type { LicenceCode } from './errors.ts'
import { deepLink, escapeHtml } from './mail.ts'
import { MESSAGES } from './messages.ts'

export const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

/** How often the waiting page reloads itself, in seconds. */
export const PENDING_RELOAD_SECONDS = 5
/** Reloads before the waiting page stops, so a forgotten tab does not poll Stripe for days. */
export const PENDING_CHECKS = 60

interface PageOptions {
  status?: number
  script?: boolean
  refresh?: { seconds: number; url: string }
}

function page(title: string, body: string, options: PageOptions = {}): Response {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="robots" content="noindex">',
    options.refresh
      ? `<meta http-equiv="refresh" content="${options.refresh.seconds};url=${escapeHtml(options.refresh.url)}">`
      : '',
    `<title>${escapeHtml(title)} - ${escapeHtml(MESSAGES.product)}</title>`,
    `<link rel="stylesheet" href="${ASSETS.style}">`,
    options.script ? `<script src="${ASSETS.copy}" defer></script>` : '',
  ].join('')
  const html =
    `<!doctype html><html lang="en"><head>${head}</head><body>` +
    `<header class="bar"><a class="brand" href="${MESSAGES.siteUrl}" aria-label="${escapeHtml(MESSAGES.home)}">` +
    `${doveSvg(28)}<span>${escapeHtml(MESSAGES.product)}</span></a></header>` +
    `<main><h1>${escapeHtml(title)}</h1>${body}</main>` +
    `<footer class="foot"><a href="${MESSAGES.siteUrl}">${escapeHtml(MESSAGES.site)}</a></footer>` +
    `</body></html>`
  return new Response(html, { status: options.status ?? 200, headers: PAGE_HEADERS })
}

const p = (text: string, className?: string) =>
  `<p${className ? ` class="${className}"` : ''}>${escapeHtml(text)}</p>`

export function donePage(key: string): Response {
  return page(
    MESSAGES.doneTitle,
    [
      p(MESSAGES.doneLead, 'lead'),
      `<p class="label" id="key-label">${escapeHtml(MESSAGES.keyLabel)}</p>`,
      `<pre class="key" id="licence-key" aria-labelledby="key-label">${escapeHtml(key)}</pre>`,
      '<div class="actions">',
      `<a class="button primary" href="${escapeHtml(deepLink(key))}">${escapeHtml(MESSAGES.open)}</a>`,
      `<button class="button" type="button" hidden data-copy="licence-key" data-status="copy-status"` +
        ` data-copied="${escapeHtml(MESSAGES.copied)}" data-failed="${escapeHtml(MESSAGES.copyFailed)}">` +
        `${escapeHtml(MESSAGES.copy)}</button>`,
      '</div>',
      '<p class="status" id="copy-status" role="status" aria-live="polite"></p>',
      p(MESSAGES.covers),
      `<h2>${escapeHtml(MESSAGES.manualTitle)}</h2>`,
      p(MESSAGES.manual),
      `<p class="muted">${escapeHtml(MESSAGES.doneMailed)} ${escapeHtml(MESSAGES.doneLater)} ` +
        `<a href="/resend">${escapeHtml(MESSAGES.resendLink)}</a></p>`,
    ].join(''),
    { script: true },
  )
}

export function pendingPage(sessionId: string, check: number): Response {
  const done = `/done?session_id=${encodeURIComponent(sessionId)}`
  const lead = `<p class="lead">${escapeHtml(MESSAGES.pendingBody)}</p>`
  if (check >= PENDING_CHECKS) {
    return page(
      MESSAGES.pendingTitle,
      lead +
        `<p class="muted">${escapeHtml(MESSAGES.pendingStopped)} ` +
        `<a href="${escapeHtml(done)}">${escapeHtml(MESSAGES.pendingCheckAgain)}</a></p>`,
      { status: 202 },
    )
  }
  return page(
    MESSAGES.pendingTitle,
    lead +
      `<p class="wait muted"><span class="spinner" aria-hidden="true"></span>${escapeHtml(MESSAGES.pendingReload)}</p>` +
      `<p class="muted"><a href="${escapeHtml(`${done}&check=${PENDING_CHECKS}`)}">${escapeHtml(MESSAGES.pendingStop)}</a></p>`,
    {
      status: 202,
      refresh: { seconds: PENDING_RELOAD_SECONDS, url: `${done}&check=${check + 1}` },
    },
  )
}

export function resendPage(): Response {
  return page(
    MESSAGES.resendTitle,
    p(MESSAGES.resendBody, 'lead') +
      `<form method="post" action="/resend" class="form">` +
      `<label for="email">${escapeHtml(MESSAGES.resendField)}</label>` +
      `<input id="email" type="email" name="email" required maxlength="254" autocomplete="email">` +
      `<button class="button primary" type="submit">${escapeHtml(MESSAGES.resendButton)}</button></form>`,
  )
}

export function resentPage(): Response {
  return page(MESSAGES.resentTitle, p(MESSAGES.resentBody, 'lead'))
}

export function errorPage(code: LicenceCode, status: number): Response {
  return page(
    MESSAGES.errorTitle,
    p(MESSAGES.errors[code], 'lead') +
      `<p class="code">${escapeHtml(MESSAGES.errorCode)}: <code>${code}</code></p>`,
    { status },
  )
}
