import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../licence/src/app'
import {
  fromBase64Url,
  newLicenceId,
  signLicence,
  signerFromSeed,
  verifyActivation,
} from '../../licence/src/format'
import { d1Store, type SqlDatabase } from '../../licence/src/store'
import { d1Database, FakeStripe, RecordingMailer, vectors } from './support'

// Activation, the seat limit and the devices page on a real D1 database.

const ORIGIN = 'https://licence.test'
const seed = fromBase64Url(vectors.keys[0]?.seed ?? '') ?? new Uint8Array()
const publicKeys = { test: fromBase64Url(vectors.keys[0]?.publicKey ?? '') ?? new Uint8Array() }
const device = (n: number) => `${'A'.repeat(21)}${n}`
const LICENSEE = 'buyer@example.com'

let db: SqlDatabase
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await d1Database())
})
afterAll(() => close())

let app: (request: Request) => Promise<Response>
let clock: Date
let licenceId: string
let key: string

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM activations'),
    db.prepare('DELETE FROM purchases'),
    db.prepare('DELETE FROM licences'),
    db.prepare('DELETE FROM rate_limits'),
    db.prepare('DELETE FROM revoked_payments'),
  ])
  clock = new Date('2026-10-31T09:00:00Z')
  licenceId = newLicenceId()
  const signer = await signerFromSeed('test', seed)
  key = await signLicence(signer, {
    id: licenceId,
    licensee: LICENSEE,
    issuedAt: '2026-10-01T00:00:00Z',
  })
  await d1Store(db).issue({
    sessionId: `cs_test_${licenceId}`,
    licenceId,
    customerId: 'cus_1',
    paymentIntent: null,
    at: '2026-10-01T00:00:00Z',
  })
  app = createApp({
    store: d1Store(db),
    stripe: new FakeStripe(),
    mailer: new RecordingMailer(),
    signer,
    publicKeys,
    config: {
      managedPayments: true,
      priceLicence: 'price_licence',
      cancelUrl: undefined,
      webhookSecret: 'whsec_test',
      maxDevices: 3,
    },
    rateSecret: new Uint8Array(32).fill(1),
    defer: () => {},
    now: () => clock,
    log: () => {},
  })
})

const post = (path: string, body: unknown) =>
  app(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

async function activate(target = device(1), label = 'Mac') {
  const response = await post('/activate', { key, device: target, label })
  return { response, body: (await response.json()) as Record<string, unknown> }
}

describe('activation', () => {
  it('takes a seat and answers with a lease the app verifies offline', async () => {
    const { response, body } = await activate()
    expect(response.status).toBe(200)
    expect(body['used']).toBe(1)
    expect(body['limit']).toBe(3)
    const verified = await verifyActivation(String(body['lease']), publicKeys)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload).toMatchObject({
      id: licenceId,
      device: device(1),
      kid: 'test',
      issuedAt: '2026-10-31T09:00:00Z',
      expiresAt: '2026-11-30T09:00:00Z',
    })
  })

  it('activates a complimentary key that has no row in D1', async () => {
    const free = newLicenceId()
    const signer = await signerFromSeed('test', seed)
    const freeKey = await signLicence(signer, {
      id: free,
      licensee: LICENSEE,
      issuedAt: '2026-10-01T00:00:00Z',
    })
    const response = await post('/activate', { key: freeKey, device: device(1), label: 'Mac' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    const verified = await verifyActivation(String(body['lease']), publicKeys)
    expect(verified.ok && verified.payload.id).toBe(free)
    expect(await d1Store(db).activations(free)).toHaveLength(1)
  })
  it('refreshes a seat a device already holds instead of taking another', async () => {
    await activate()
    clock = new Date('2026-11-01T09:00:00Z')
    const { body } = await activate()
    expect(body['used']).toBe(1)
    const rows = await d1Store(db).activations(licenceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lastSeenAt).toBe('2026-11-01T09:00:00Z')
    expect(rows[0]?.createdAt).toBe('2026-10-31T09:00:00Z')
  })

  it('refuses a fourth device and takes no seat for it', async () => {
    for (const n of [1, 2, 3]) expect((await activate(device(n))).response.status).toBe(200)
    const { response, body } = await activate(device(4))
    expect(response.status).toBe(409)
    expect(body['code']).toBe('E_LICENCE_DEVICE_LIMIT')
    expect(await d1Store(db).activations(licenceId)).toHaveLength(3)
  })

  it('frees a seat when a device is deactivated, and it can be taken again', async () => {
    await activate(device(1))
    const freed = await post('/deactivate', { key, device: device(1) })
    expect(await freed.json()).toEqual({ deactivated: true })
    for (const n of [2, 3, 4]) expect((await activate(device(n))).response.status).toBe(200)
    expect((await activate(device(5))).response.status).toBe(409)
  })

  it('refuses a revoked licence and a key that does not verify', async () => {
    await db
      .prepare('UPDATE licences SET revoked_at = ?1 WHERE id = ?2')
      .bind('2026-10-30T00:00:00Z', licenceId)
      .run()
    const revoked = await activate()
    expect(revoked.response.status).toBe(410)
    expect(revoked.body['code']).toBe('E_LICENCE_REVOKED')
    const foreign = await signLicence(await signerFromSeed('test', new Uint8Array(32).fill(7)), {
      id: newLicenceId(),
      licensee: LICENSEE,
      issuedAt: '2026-10-01T00:00:00Z',
    })
    const borrowed = `${key.split('.').slice(0, 2).join('.')}.${foreign.split('.')[2]}`
    const tampered = await post('/activate', { key: borrowed, device: device(1) })
    expect(tampered.status).toBe(400)
    expect(((await tampered.json()) as Record<string, unknown>)['code']).toBe('E_LICENCE_SIGNATURE')
  })

  it('refuses a device ID of the wrong shape', async () => {
    const response = await post('/activate', { key, device: 'not-a-device', label: 'Mac' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe(
      'E_LICENCE_BAD_REQUEST',
    )
  })

  it('lists the seats on the devices page and removes one from it', async () => {
    await activate(device(1), 'Mac')
    await activate(device(2), 'iPhone')
    const form = (fields: Record<string, string>) => {
      const body = new URLSearchParams(fields)
      return app(
        new Request(`${ORIGIN}/devices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }),
      )
    }
    const listed = await form({ key })
    expect(listed.status).toBe(200)
    const html = await listed.text()
    expect(html).toContain('Mac')
    expect(html).toContain('iPhone')
    expect(html).toContain('2 devices in use, of 3')

    const removed = await form({ key, device: device(2) })
    expect(removed.status).toBe(200)
    const after = await removed.text()
    expect(after).toContain('That device no longer holds a seat.')
    expect(after).not.toContain('iPhone')
    expect(await d1Store(db).activations(licenceId)).toHaveLength(1)
  })
})
