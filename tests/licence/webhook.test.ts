import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { signStripePayload, verifyStripeSignature } from '../../licence/src/webhook'

const secret = 'whsec_test_0123456789abcdef'
const body = '{"id":"evt_1","type":"checkout.session.completed"}'
const now = 1_790_000_000
// What Stripe documents, computed apart from the code under test.
const mac = (t: number, payload = body, key = secret) =>
  createHmac('sha256', key).update(`${t}.${payload}`).digest('hex')

it('accepts a v1 signature over `t.body` within five minutes', async () => {
  expect(await verifyStripeSignature(body, `t=${now},v1=${mac(now)}`, secret, now)).toBe(true)
  expect(
    await verifyStripeSignature(body, `t=${now - 300},v1=${mac(now - 300)}`, secret, now),
  ).toBe(true)
  expect(
    await verifyStripeSignature(body, `t=${now + 300},v1=${mac(now + 300)}`, secret, now),
  ).toBe(true)
})

it('accepts any of several v1 signatures, as during a secret roll', async () => {
  const header = `t=${now},v1=${mac(now, body, 'whsec_old')},v0=${mac(now)},v1=${mac(now)}`
  expect(await verifyStripeSignature(body, header, secret, now)).toBe(true)
})

it('refuses an old, future, forged or missing signature', async () => {
  const refused = [
    null,
    '',
    `t=${now}`,
    `v1=${mac(now)}`,
    `t=${now - 301},v1=${mac(now - 301)}`,
    `t=${now + 301},v1=${mac(now + 301)}`,
    `t=${now},v1=${mac(now, body + ' ')}`,
    `t=${now},v1=${mac(now, body, 'whsec_other')}`,
    `t=${now},v0=${mac(now)}`,
    `t=${now},v1=${mac(now).toUpperCase()}`,
    `t=${now},v1=${mac(now).slice(2)}`,
    `t=abc,v1=${mac(now)}`,
  ]
  const accepted = []
  for (const header of refused) {
    if (await verifyStripeSignature(body, header, secret, now)) accepted.push(header)
  }
  expect(accepted).toEqual([])
})

it('signs a payload the way it verifies one', async () => {
  const header = await signStripePayload(body, secret, now)
  expect(header).toBe(`t=${now},v1=${mac(now)}`)
})
