import { LicenceError } from './errors.ts'
import { MESSAGES } from './messages.ts'

export interface Mail {
  to: string
  subject: string
  text: string
  html: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

/** The `send_email` binding of Cloudflare Email Service, as far as the Worker uses it. */
export interface SendEmailBinding {
  send(message: {
    from: { email: string; name: string }
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

export function cloudflareMailer(binding: SendEmailBinding, from: string): Mailer {
  return {
    async send(mail) {
      try {
        await binding.send({ from: { email: from, name: MESSAGES.product }, ...mail })
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        throw new LicenceError('E_LICENCE_MAIL', typeof code === 'string' ? code : undefined)
      }
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
  return { to, subject, text, html }
}
