import type { LicenceCode } from './errors.ts'
import { deepLink, escapeHtml } from './mail.ts'
import { MESSAGES } from './messages.ts'

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}' +
  'code{word-break:break-all}textarea{width:100%;font:14px ui-monospace,monospace}'

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
  return new Response(html, { status, headers: HEADERS })
}

const p = (text: string) => `<p>${escapeHtml(text)}</p>`

export function donePage(key: string): Response {
  return page(
    MESSAGES.doneTitle,
    [
      p(MESSAGES.doneKey),
      `<p><textarea readonly rows="5">${escapeHtml(key)}</textarea></p>`,
      p(MESSAGES.covers),
      `<p><a href="${escapeHtml(deepLink(key))}">${escapeHtml(MESSAGES.open)}</a></p>`,
      p(MESSAGES.paste),
      `<p>${escapeHtml(MESSAGES.doneMailed)} <a href="/resend">${escapeHtml(MESSAGES.resendLink)}</a></p>`,
    ].join(''),
  )
}

export function pendingPage(): Response {
  return page(MESSAGES.pendingTitle, p(MESSAGES.pendingBody), 202)
}

export function resendPage(): Response {
  return page(
    MESSAGES.resendTitle,
    p(MESSAGES.resendBody) +
      `<form method="post" action="/resend"><p><label>${escapeHtml(MESSAGES.resendField)} ` +
      `<input type="email" name="email" required maxlength="254" autocomplete="email"></label> ` +
      `<button type="submit">${escapeHtml(MESSAGES.resendButton)}</button></p></form>`,
  )
}

export function resentPage(): Response {
  return page(MESSAGES.resentTitle, p(MESSAGES.resentBody))
}

export function errorPage(code: LicenceCode, status: number): Response {
  return page(
    MESSAGES.errorTitle,
    p(MESSAGES.errors[code]) + `<p><small>${code}</small></p>`,
    status,
  )
}
