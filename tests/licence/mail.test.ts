import { describe, expect, it } from 'vitest'
import { LicenceError } from '../../licence/src/errors'
import { resendMailer, type Mail } from '../../licence/src/mail'

const mail: Mail = {
  to: 'buyer@example.test',
  subject: 'Your Devot licence',
  text: 'devot1.SECRETKEY',
  html: '<p>devot1.SECRETKEY</p>',
  idempotencyKey: 'issued/cs_test_1',
}

function recording(answer: () => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer()
  }
  return { calls, mailer: resendMailer('re_secret_key', 'licence@devot.test', fetcher) }
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
      from: 'licence@devot.test',
      to: ['buyer@example.test'],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
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
