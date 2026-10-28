import { COLORS, DOVE, doveSvg } from './brand.ts'
import { LicenceError } from './errors.ts'
import { MESSAGES } from './messages.ts'

export interface Mail {
  to: string
  subject: string
  text: string
  html: string
  /** Resend drops a repeat of a key for 24 hours, so a retried send mails once. */
  idempotencyKey?: string | undefined
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

const RESEND_URL = 'https://api.resend.com/emails'
/** Shorter than the Worker's 30 s waitUntil budget, so a hung Resend call cannot strand the claim. */
export const MAIL_TIMEOUT_MS = 10_000

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Resend's error name when it looks like one; never the message, which can hold an address. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const name = ((await response.json()) as { name?: unknown } | null)?.name
    if (typeof name === 'string' && /^[a-z_]{1,64}$/.test(name)) return name
  } catch {
    // not JSON
  }
  return `http_${response.status}`
}

export function resendMailer(
  apiKey: string,
  from: string,
  fetcher: Fetch = (input, init) => fetch(input, init),
  replyTo?: string,
): Mailer {
  return {
    async send(mail) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }
      if (mail.idempotencyKey) headers['Idempotency-Key'] = mail.idempotencyKey
      let response: Response
      try {
        response = await fetcher(RESEND_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from: `${MESSAGES.product} <${from}>`,
            to: [mail.to],
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            ...(replyTo?.trim() ? { reply_to: replyTo.trim() } : {}),
          }),
          signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
        })
      } catch {
        throw new LicenceError('E_LICENCE_MAIL', 'network')
      }
      if (!response.ok) throw new LicenceError('E_LICENCE_MAIL', await errorDetail(response))
    },
  }
}

export function deepLink(key: string): string {
  return `devot://licence?key=${encodeURIComponent(key)}`
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function licenceMail(
  to: string,
  kind: 'issued' | 'resend',
  keys: string[],
  idempotencyKey?: string,
): Mail {
  const m = MESSAGES.mail
  const subject = kind === 'issued' ? m.issuedSubject : m.resendSubject
  const intro = kind === 'issued' ? m.issuedIntro : m.resendIntro
  const after = [MESSAGES.covers, MESSAGES.manual, m.refund, m.support, m.keep]
  const text = [
    intro,
    ...keys.flatMap((key) => [
      `${MESSAGES.keyLabel}:\n${key}`,
      `${MESSAGES.open}: ${deepLink(key)}`,
    ]),
    ...after,
    MESSAGES.siteUrl,
  ].join('\n\n')
  return { to, subject, text, html: mailHtml(subject, intro, keys, after), idempotencyKey }
}

const light = COLORS.light
const dark = COLORS.dark
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'

// Mail clients drop linked stylesheets and many drop <style>, so every rule is inline and the
// <style> block only darkens what clients that honour prefers-color-scheme can darken.
const MAIL_DARK =
  `@media (prefers-color-scheme:dark){` +
  `.page{background:${dark['surface-editor']}!important;color:${dark['text-primary']}!important}` +
  `.text{color:${dark['text-primary']}!important}` +
  `.muted{color:${dark['text-secondary']}!important}` +
  `.key{background:${dark['fill-card']}!important;border-color:${dark['line-separator']}!important;color:${dark['text-primary']}!important}` +
  `.link{color:${dark['accent-text']}!important}` +
  DOVE.ink.dark.map((color, i) => `.ink-${i}{stop-color:${color}!important}`).join('') +
  `}`

function mailHtml(subject: string, intro: string, keys: string[], after: string[]): string {
  const para = (text: string, muted = false) =>
    `<p class="${muted ? 'muted' : 'text'}" style="margin:0 0 16px;color:${muted ? light['text-secondary'] : light['text-primary']}">${escapeHtml(text)}</p>`
  const keyBlocks = keys.map(
    (key) =>
      `<p class="muted" style="margin:24px 0 8px;color:${light['text-secondary']};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">${escapeHtml(MESSAGES.keyLabel)}</p>` +
      `<div class="key" style="padding:14px 16px;border:1px solid ${light['line-separator']};border-radius:12px;background:${light['fill-card']};color:${light['text-primary']};font:15px/1.5 ${MONO};word-break:break-all;overflow-wrap:anywhere">${escapeHtml(key)}</div>` +
      `<p style="margin:16px 0 8px"><a href="${escapeHtml(deepLink(key))}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${light['activity-level-4']};color:${light['accent-on-fill']};font-weight:600;text-decoration:none">${escapeHtml(MESSAGES.open)}</a></p>`,
  )
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${escapeHtml(subject)}</title><style>${MAIL_DARK}</style></head>` +
    `<body class="page" style="margin:0;padding:0;background:${light['surface-editor']};color:${light['text-primary']}">` +
    `<div class="page" style="max-width:560px;margin:0 auto;padding:32px 24px;background:${light['surface-editor']};color:${light['text-primary']};font:16px/1.55 ${FONT}">` +
    `<p style="margin:0 0 28px;font-size:18px;font-weight:600">${doveSvg(28, 'devot-ink', 'vertical-align:-6px')} ${escapeHtml(MESSAGES.product)}</p>` +
    para(intro) +
    keyBlocks.join('') +
    `<div style="margin-top:24px">${after.map((text, i) => para(text, i > 0)).join('')}</div>` +
    `<p class="muted" style="margin:32px 0 0;padding-top:16px;border-top:1px solid ${light['line-separator']};color:${light['text-secondary']};font-size:14px">` +
    `<a class="link" href="${MESSAGES.siteUrl}" style="color:${light['accent-text']}">${escapeHtml(MESSAGES.site)}</a></p>` +
    `</div></body></html>`
  )
}
