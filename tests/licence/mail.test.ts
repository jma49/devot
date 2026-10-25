import { describe, expect, it } from 'vitest'
import { LicenceError } from '../../licence/src/errors'
import { DOVE } from '../../licence/src/brand'
import { licenceMail, resendMailer, type Mail } from '../../licence/src/mail'
import { MESSAGES } from '../../licence/src/messages'

const mail: Mail = {
  to: 'buyer@example.test',
  subject: 'Your Devot licence',
  text: 'devot1.SECRETKEY',
  html: '<p>devot1.SECRETKEY</p>',
  idempotencyKey: 'issued/cs_test_1',
}

function recording(answer: () => Response, replyTo?: string) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer()
  }
  return { calls, mailer: resendMailer('re_secret_key', 'licence@devot.test', fetcher, replyTo) }
}

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

async function failure(answer: Response | Error): Promise<LicenceError> {
  const { mailer } = recording(() => {
    if (answer instanceof Error) throw answer
    return answer
  })
  try {
    await mailer.send(mail)
  } catch (error) {
    return error as LicenceError
  }
  throw new Error('send did not fail')
}

describe('resendMailer', () => {
  it('posts one JSON message with the bearer key and an idempotency key', async () => {
    const { calls, mailer } = recording(() => json({ id: 'em_1' }, 200))
    await mailer.send(mail)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.resend.com/emails')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toEqual({
      Authorization: 'Bearer re_secret_key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'issued/cs_test_1',
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: 'Devot <licence@devot.test>',
      to: ['buyer@example.test'],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
  })

  it('sends reply_to when a Reply-To address is set', async () => {
    const { calls, mailer } = recording(() => json({ id: 'em_1' }, 200), 'owner@example.test')
    await mailer.send(mail)
    expect(JSON.parse(String(calls[0]?.init.body)).reply_to).toBe('owner@example.test')
  })

  it('omits reply_to when no Reply-To address is set or it is empty', async () => {
    for (const replyTo of [undefined, '', '   ']) {
      const { calls, mailer } = recording(() => json({ id: 'em_1' }, 200), replyTo)
      await mailer.send(mail)
      expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('reply_to')
    }
  })

  it('omits the idempotency header when the mail has no key', async () => {
    const { calls, mailer } = recording(() => json({ id: 'em_1' }, 200))
    await mailer.send({ ...mail, idempotencyKey: undefined })
    expect(Object.keys(calls[0]?.init.headers as object)).not.toContain('Idempotency-Key')
  })

  it.each([
    [400, 'validation_error'],
    [403, 'validation_error'],
    [403, 'email_above_quota'],
    [409, 'concurrent_idempotent_requests'],
    [409, 'invalid_idempotent_request'],
    [429, 'rate_limit_exceeded'],
    [429, 'daily_quota_exceeded'],
    [429, 'monthly_quota_exceeded'],
    [500, 'application_error'],
    [503, 'service_unavailable'],
  ])('maps %i %s to E_LICENCE_MAIL with the error name', async (status, name) => {
    const error = await failure(
      json({ name, message: 'to buyer@example.test', statusCode: status }, status),
    )
    expect(error.code).toBe('E_LICENCE_MAIL')
    expect(error.detail).toBe(name)
  })

  it('falls back to the status when the body has no usable name', async () => {
    expect(
      (await failure(new Response('<html>buyer@example.test</html>', { status: 502 }))).detail,
    ).toBe('http_502')
    expect((await failure(json({ name: 'a b@example.test' }, 400))).detail).toBe('http_400')
  })

  it('reports a network failure without its message', async () => {
    const error = await failure(new Error('connect to buyer@example.test re_secret_key'))
    expect(error.code).toBe('E_LICENCE_MAIL')
    expect(error.detail).toBe('network')
  })

  it('never puts an address, a key or a body in an error', async () => {
    const error = await failure(
      json(
        {
          name: 'validation_error',
          message: 'bad buyer@example.test re_secret_key devot1.SECRETKEY',
        },
        403,
      ),
    )
    expect(error.message).toBe('E_LICENCE_MAIL validation_error')
    expect(error.message).not.toMatch(/buyer|re_secret|SECRETKEY/)
  })
})

describe('licenceMail', () => {
  it('gives each key its link and says once that a licence unlocks every version', () => {
    const sent = licenceMail('buyer@example.test', 'resend', ['devot1.a.b', 'devot1.c.d'], 'r/1')
    expect(sent.subject).toBe('Your Devot licences')
    expect(sent.idempotencyKey).toBe('r/1')
    for (const body of [sent.text, sent.html]) {
      expect(body).toContain('devot://licence?key=devot1.a.b')
      expect(body).toContain('devot://licence?key=devot1.c.d')
      expect(body.match(/every version of Devot/g)).toHaveLength(1)
      expect(body).not.toMatch(/until/i)
    }
    expect(licenceMail('buyer@example.test', 'issued', ['devot1.a.b']).subject).toBe(
      'Your Devot licence',
    )
  })
})

describe('the licence email', () => {
  const KEY = 'devot1.eyJpZCI6IkFBQSJ9.c2lnbmF0dXJl'

  it('says the same in its HTML and text parts', () => {
    const sent = licenceMail('buyer@example.test', 'issued', [KEY])
    const html = sent.html.replaceAll('&gt;', '>')
    for (const body of [sent.text, html]) {
      for (const text of [
        MESSAGES.mail.issuedIntro,
        KEY,
        `devot://licence?key=${encodeURIComponent(KEY)}`,
        MESSAGES.open,
        MESSAGES.covers,
        MESSAGES.manual,
        MESSAGES.mail.refund,
        MESSAGES.mail.support,
        MESSAGES.mail.keep,
      ]) {
        expect(body).toContain(text)
      }
    }
    expect(sent.text).not.toMatch(/<[a-z]/)
    expect(MESSAGES.mail.refund).toMatch(/30 days/)
    expect(MESSAGES.mail.support).toMatch(/[Rr]eply/)
  })

  it('is a self-contained page in light and dark with the dove and no script or remote content', () => {
    const { html } = licenceMail('buyer@example.test', 'issued', [KEY])
    expect(html).toMatch(/^<!doctype html><html lang="en">/)
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('@media (prefers-color-scheme:dark)')
    expect(html).toContain(`d="${DOVE.path}"`)
    expect(html).not.toMatch(/<script|<img|<link|url\(http|@import/)
    const external = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1])
    expect(new Set(external)).toEqual(new Set([MESSAGES.siteUrl]))
  })

  it('escapes keys and URL-encodes them in the deep link', () => {
    const hostile = `devot1.<b>"x"</b>&'+/=?#.sig`
    const { html, text } = licenceMail('buyer@example.test', 'resend', [hostile])
    expect(html).not.toContain('<b>')
    expect(html).toContain('devot1.&lt;b&gt;&quot;x&quot;&lt;/b&gt;&amp;&#39;+/=?#.sig')
    expect(html).toContain(
      `href="${`devot://licence?key=${encodeURIComponent(hostile)}`.replace(/'/g, '&#39;')}"`,
    )
    expect(text).toContain(`devot://licence?key=${encodeURIComponent(hostile)}`)
  })
})
