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
            from,
            to: [mail.to],
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          }),
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

export interface MailedKey {
  key: string
  updatesUntil: string
}

export function licenceMail(
  to: string,
  kind: 'issued' | 'renewed' | 'resend',
  keys: MailedKey[],
  idempotencyKey?: string,
): Mail {
  const m = MESSAGES.mail
  const subject = { issued: m.issuedSubject, renewed: m.renewedSubject, resend: m.resendSubject }[
    kind
  ]
  const intro = { issued: m.issuedIntro, renewed: m.renewedIntro, resend: m.resendIntro }[kind]
  const text = [
    intro,
    ...keys.flatMap(({ key, updatesUntil }) => [
      key,
      MESSAGES.covers(updatesUntil),
      `${MESSAGES.open}: ${deepLink(key)}`,
    ]),
    MESSAGES.paste,
    m.keep,
  ].join('\n\n')
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    ...keys.map(
      ({ key, updatesUntil }) =>
        `<p><code style="word-break:break-all">${escapeHtml(key)}</code></p>` +
        `<p>${escapeHtml(MESSAGES.covers(updatesUntil))}</p>` +
        `<p><a href="${escapeHtml(deepLink(key))}">${escapeHtml(MESSAGES.open)}</a></p>`,
    ),
    `<p>${escapeHtml(MESSAGES.paste)}</p>`,
    `<p>${escapeHtml(m.keep)}</p>`,
  ].join('\n')
  return { to, subject, text, html, idempotencyKey }
}
