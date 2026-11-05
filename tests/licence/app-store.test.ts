import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../licence/src/app'
import { appleApi } from '../../licence/src/app-store'
import { APP_STORE_LIMITS } from '../../licence/src/app-store-routes'
import {
  APP_STORE_LICENSEE,
  fromBase64Url,
  publicKeyFromSeed,
  signerFromSeed,
  verifyActivation,
  verifyLicence,
  verifyRevocations,
} from '../../licence/src/format'
import { d1Store, type SqlDatabase } from '../../licence/src/store'
import {
  BUNDLE,
  chain,
  type Chain,
  inAppPurchaseKey,
  PRO,
  signJws,
  transaction,
  TRIAL,
} from './apple-support'
import { d1Database, FakeStripe, RecordingMailer, vectors } from './support'

// The licence exchange, App Store Server Notifications and the renewal check on a real D1
// database. Apple's App Store Server API is answered by `FakeApple` behind the client's fetch,
// signing with a chain made here whose root the Worker is handed in place of Apple's.

const ORIGIN = 'https://licence.test'
const testSeed = fromBase64Url(vectors.keys[0]?.seed ?? '') ?? new Uint8Array()
const testPublic = fromBase64Url(vectors.keys[0]?.publicKey ?? '') ?? new Uint8Array()
const prodSeed = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff)
const device = (n: number) => `${'D'.repeat(20)}${String(n).padStart(2, '0')}`
const NOW = new Date('2026-11-05T09:00:00Z')

let db: SqlDatabase
let close: () => Promise<void>
let apple: FakeApple
let signing: Chain
let iap: Awaited<ReturnType<typeof inAppPurchaseKey>>
let prodPublic: Uint8Array
/** Every line any app logged in this file, checked for secrets at the end. */
const allLogs: string[] = []
/** Every JWS, transaction ID and key the tests made, none of which may reach a log. */
const secrets = new Set<string>()

type Environment = 'Production' | 'Sandbox'

/** Apple's App Store Server API as far as Get Transaction Info goes. */
class FakeApple {
  readonly transactions = new Map<string, Record<string, unknown>>()
  readonly calls: { environment: Environment; transactionId: string }[] = []
  readonly tokens: { header: Record<string, unknown>; claims: Record<string, unknown> }[] = []
  /** Answer every call with this status, or fail the connection. */
  failure: number | 'network' | null = null

  put(payload: Record<string, unknown>) {
    const environment = payload['environment'] as Environment
    this.transactions.set(`${environment}:${String(payload['transactionId'])}`, payload)
    secrets.add(String(payload['transactionId']))
    secrets.add(String(payload['originalTransactionId']))
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const environment: Environment | null =
      url.host === 'api.storekit.itunes.apple.com'
        ? 'Production'
        : url.host === 'api.storekit-sandbox.itunes.apple.com'
          ? 'Sandbox'
          : null
    const id = /^\/inApps\/v1\/transactions\/(\d+)$/.exec(url.pathname)?.[1]
    if (!environment || !id) return new Response(null, { status: 404 })
    this.calls.push({ environment, transactionId: id })
    if (!(await this.authorised(request))) return new Response(null, { status: 401 })
    if (this.failure === 'network') throw new TypeError('fetch failed')
    if (this.failure !== null) return new Response(null, { status: this.failure })
    const payload = this.transactions.get(`${environment}:${id}`)
    if (!payload) return Response.json({ errorCode: 4040010 }, { status: 404 })
    return Response.json({ signedTransactionInfo: await signJws(payload, signing) })
  }

  private async authorised(request: Request): Promise<boolean> {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
    const [header, claims, signature] = token.split('.')
    const decode = (part: string | undefined) =>
      JSON.parse(new TextDecoder().decode(fromBase64Url(part ?? '') ?? new Uint8Array()))
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      iap.publicKey,
      (fromBase64Url(signature ?? '') ?? new Uint8Array()) as BufferSource,
      new TextEncoder().encode(`${header}.${claims}`) as BufferSource,
    )
    if (valid) this.tokens.push({ header: decode(header), claims: decode(claims) })
    return valid
  }
}

beforeAll(async () => {
  ;({ db, close } = await d1Database())
  signing = await chain()
  iap = await inAppPurchaseKey()
  prodPublic = await publicKeyFromSeed(prodSeed)
})
afterAll(() => close())

let clock: Date
let logs: string[]
let app: (request: Request) => Promise<Response>

interface BuildOptions {
  kid?: string
  publicKeys?: Record<string, Uint8Array>
  appStore?: boolean
  productPro?: string
}

async function build(options: BuildOptions = {}) {
  const kid = options.kid ?? 'prod-2026'
  return createApp({
    store: d1Store(db),
    stripe: new FakeStripe(),
    mailer: new RecordingMailer(),
    signer: await signerFromSeed(kid, kid === 'test' ? testSeed : prodSeed),
    publicKeys: options.publicKeys ?? { [kid]: kid === 'test' ? testPublic : prodPublic },
    config: {
      managedPayments: true,
      priceLicence: 'price_licence',
      cancelUrl: undefined,
      webhookSecret: 'whsec_test',
      maxDevices: 3,
    },
    rateSecret: new Uint8Array(32).fill(2),
    defer: () => {},
    now: () => clock,
    log: (line) => {
      logs.push(line)
      allLogs.push(line)
    },
    appStore:
      options.appStore === false
        ? null
        : {
            config: { bundleId: BUNDLE, productPro: options.productPro ?? PRO },
            apple: appleApi({
              key: iap.pem,
              keyId: 'TESTKEY123',
              issuerId: '57246542-96fe-1a63-e053-0824d011072a',
              bundleId: BUNDLE,
              fetch: apple.fetch,
              now: () => clock,
            }),
            sandboxSigner: await signerFromSeed('test', testSeed),
            root: signing.root.der,
          },
  })
}

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM activations'),
    db.prepare('DELETE FROM purchases'),
    db.prepare('DELETE FROM licences'),
    db.prepare('DELETE FROM rate_limits'),
    db.prepare('DELETE FROM app_store_licences'),
    db.prepare('DELETE FROM app_store_notifications'),
  ])
  apple = new FakeApple()
  clock = NOW
  logs = []
  app = await build()
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    }),
  )

/** A JWS StoreKit would hand the app, for a purchase Apple also knows. */
async function bought(overrides: Record<string, unknown> = {}, known = true) {
  const payload = transaction(overrides)
  if (known) apple.put(payload)
  const jws = await signJws(payload, signing)
  secrets.add(jws)
  return { payload, jws }
}

async function exchange(jws: unknown, ip = '203.0.113.7') {
  const response = await post(
    '/app-store/exchange',
    { transaction: jws },
    { 'CF-Connecting-IP': ip },
  )
  const body = (await response.json()) as { key?: string; id?: string; code?: string }
  if (body.key) secrets.add(body.key)
  return { status: response.status, ...body }
}

async function notify(
  type: string,
  payload: Record<string, unknown>,
  overrides: { data?: Record<string, unknown>; uuid?: string; by?: Chain } = {},
) {
  const by = overrides.by ?? signing
  const signedTransactionInfo = await signJws(payload, by)
  const signedPayload = await signJws(
    {
      notificationType: type,
      notificationUUID: overrides.uuid ?? crypto.randomUUID(),
      data: {
        appAppleId: 1234,
        bundleId: BUNDLE,
        environment: payload['environment'],
        signedTransactionInfo,
        ...overrides.data,
      },
      version: '2.0',
      signedDate: clock.getTime(),
    },
    by,
  )
  secrets.add(signedPayload)
  secrets.add(signedTransactionInfo)
  const response = await post('/app-store/notifications', { signedPayload })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const activate = async (key: string, n: number) => {
  const response = await post('/activate', { key, device: device(n), label: 'Mac' })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const rows = async () =>
  (
    await db
      .prepare(
        'SELECT environment, original_transaction_id, licence_id, revoked_at, issued_at FROM app_store_licences ORDER BY environment',
      )
      .all<{
        environment: string
        original_transaction_id: string
        licence_id: string
        revoked_at: string | null
        issued_at: string | null
      }>()
  ).results

async function revokedList(): Promise<string[]> {
  const response = await app(new Request(`${ORIGIN}/revoked`))
  const result = await verifyRevocations(await response.text(), { 'prod-2026': prodPublic })
  if (!result.ok) throw new Error(result.code)
  return result.payload.ids
}

const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000)

describe('the exchange', () => {
  it('gives a Devot Pro purchase a licence key the current format verifies, with the fixed licensee', async () => {
    const { jws } = await bought()
    const result = await exchange(jws)
    expect(result.status).toBe(200)
    const verified = await verifyLicence(result.key ?? '', { 'prod-2026': prodPublic })
    expect(verified).toEqual({
      ok: true,
      payload: {
        id: result.id,
        kid: 'prod-2026',
        plan: 'pro',
        licensee: APP_STORE_LICENSEE,
        issuedAt: '2026-11-05T09:00:00Z',
      },
    })
    expect(APP_STORE_LICENSEE).toBe('App Store purchase')
    expect(apple.calls).toEqual([{ environment: 'Production', transactionId: '2000000123456789' }])
    expect(logs).toEqual([`I_APP_STORE_EXCHANGED ${result.id}`])
  })

  it("asks Apple with a five-minute ES256 token for this app's bundle", async () => {
    await exchange((await bought()).jws)
    expect(apple.tokens).toHaveLength(1)
    const [{ header, claims } = { header: {}, claims: {} }] = apple.tokens
    expect(header).toEqual({ alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' })
    expect(claims).toEqual({
      iss: '57246542-96fe-1a63-e053-0824d011072a',
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 300,
      aud: 'appstoreconnect-v1',
      bid: BUNDLE,
    })
  })

  it('refuses a forged signed transaction without asking Apple', async () => {
    const forger = await chain()
    const forged = await signJws(transaction(), forger)
    apple.put(transaction())
    expect(await exchange(forged)).toMatchObject({ status: 400, code: 'E_APP_STORE_SIGNATURE' })
    const { jws } = await bought()
    const [header, , signature] = jws.split('.')
    const tampered = `${header}.${(await signJws(transaction({ originalTransactionId: '9' }), forger)).split('.')[1]}.${signature}`
    expect(await exchange(tampered)).toMatchObject({ code: 'E_APP_STORE_SIGNATURE' })
    expect(apple.calls).toEqual([])
    expect(await rows()).toEqual([])
  })

  it("refuses when Apple's own answer is not signed by Apple", async () => {
    const { jws } = await bought()
    const real = signing
    signing = await chain()
    try {
      expect(await exchange(jws)).toMatchObject({ status: 503, code: 'E_APP_STORE_UPSTREAM' })
    } finally {
      signing = real
    }
    expect(await rows()).toEqual([])
  })

  it('never takes a bare or guessed transaction ID', async () => {
    apple.put(transaction())
    expect(await exchange('2000000123456789')).toMatchObject({ code: 'E_APP_STORE_SIGNATURE' })
    const asField = await post('/app-store/exchange', { transactionId: '2000000123456789' })
    expect(asField.status).toBe(400)
    expect(await asField.json()).toEqual({ code: 'E_LICENCE_BAD_REQUEST' })
    for (const body of ['', 'null', '[]', '"x"', '{"transaction":7}', 'not json']) {
      expect((await post('/app-store/exchange', body)).status).toBe(400)
    }
    expect(apple.calls).toEqual([])
  })

  it('refuses the free Trial before asking Apple, and on Apple’s answer', async () => {
    const trial = await bought({ productId: TRIAL })
    expect(await exchange(trial.jws)).toMatchObject({ status: 403, code: 'E_APP_STORE_PRODUCT' })
    expect(apple.calls).toEqual([])
    const claimsPro = await bought({ transactionId: '2000000000000002' }, false)
    apple.put(transaction({ transactionId: '2000000000000002', productId: TRIAL }))
    expect(await exchange(claimsPro.jws)).toMatchObject({ code: 'E_APP_STORE_PRODUCT' })
    expect(await rows()).toEqual([])
  })

  it('refuses the Trial even if the Worker were set to sell it as Pro', async () => {
    app = await build({ productPro: TRIAL })
    const trial = await bought({ productId: TRIAL })
    expect(await exchange(trial.jws)).toMatchObject({ code: 'E_APP_STORE_PRODUCT' })
    expect(apple.calls).toEqual([])
  })

  it("refuses another app's transaction, on the JWS and on Apple's answer", async () => {
    const other = await bought({ bundleId: 'com.example.other' })
    expect(await exchange(other.jws)).toMatchObject({ code: 'E_APP_STORE_PRODUCT' })
    expect(apple.calls).toEqual([])
    const claimsOurs = await bought({}, false)
    apple.put(transaction({ bundleId: 'io.github.jma49.devot.dev' }))
    expect(await exchange(claimsOurs.jws)).toMatchObject({ code: 'E_APP_STORE_PRODUCT' })
    expect(await rows()).toEqual([])
  })

  it('refuses a consumable or an unknown type, and Xcode or unknown environments', async () => {
    for (const overrides of [
      { type: 'Consumable' },
      { type: 'Auto-Renewable Subscription' },
      { environment: 'Xcode' },
      { environment: 'LocalTesting' },
      { inAppOwnershipType: 'UNKNOWN' },
    ]) {
      expect(await exchange((await bought(overrides)).jws)).toMatchObject({
        code: 'E_APP_STORE_PRODUCT',
      })
    }
    expect(apple.calls).toEqual([])
  })

  it('refuses a family-shared purchase, on the JWS and on Apple’s answer', async () => {
    const shared = await bought({ inAppOwnershipType: 'FAMILY_SHARED' })
    expect(await exchange(shared.jws)).toMatchObject({
      status: 403,
      code: 'E_APP_STORE_FAMILY_SHARED',
    })
    expect(apple.calls).toEqual([])
    const claimsOwn = await bought({}, false)
    apple.put(transaction({ inAppOwnershipType: 'FAMILY_SHARED' }))
    expect(await exchange(claimsOwn.jws)).toMatchObject({ code: 'E_APP_STORE_FAMILY_SHARED' })
    expect(await rows()).toEqual([])
  })

  it("refuses when Apple's answer is another purchase or another environment", async () => {
    const { jws } = await bought({}, false)
    apple.put(transaction({ originalTransactionId: '2000000000000099' }))
    expect(await exchange(jws)).toMatchObject({ status: 409, code: 'E_APP_STORE_MISMATCH' })
    apple.put(transaction({ transactionId: '2000000123456789', environment: 'Production' }))
    const sandboxClaim = await bought({ environment: 'Sandbox' }, false)
    apple.put(transaction({ environment: 'Sandbox', originalTransactionId: '2000000000000055' }))
    expect(await exchange(sandboxClaim.jws)).toMatchObject({ code: 'E_APP_STORE_MISMATCH' })
    expect(await rows()).toEqual([])
  })

  it('refuses when Apple does not know the transaction, or cannot be reached, and issues nothing', async () => {
    const unknown = await bought({}, false)
    expect(await exchange(unknown.jws)).toMatchObject({
      status: 404,
      code: 'E_APP_STORE_NOT_FOUND',
    })
    const { jws } = await bought()
    for (const failure of [429, 500, 503, 'network'] as const) {
      apple.failure = failure
      expect(await exchange(jws)).toMatchObject({ status: 503, code: 'E_APP_STORE_UNREACHABLE' })
    }
    expect(await rows()).toEqual([])
    expect(logs.filter((l) => l.startsWith('I_APP_STORE_EXCHANGED'))).toEqual([])
  })

  it('answers E_LICENCE_CONFIG when Apple refuses the Worker’s own key', async () => {
    const { jws } = await bought()
    apple.failure = 401
    expect(await exchange(jws)).toMatchObject({ status: 503, code: 'E_LICENCE_CONFIG' })
    expect(await rows()).toEqual([])
  })

  it('gives a sandbox purchase a key signed under the test seed, which production refuses', async () => {
    const sandbox = await bought({ environment: 'Sandbox' })
    const result = await exchange(sandbox.jws)
    expect(result.status).toBe(200)
    expect(apple.calls).toEqual([{ environment: 'Sandbox', transactionId: '2000000123456789' }])
    const asTest = await verifyLicence(result.key ?? '', { test: testPublic })
    expect(asTest.ok && asTest.payload.kid).toBe('test')
    expect(await verifyLicence(result.key ?? '', { 'prod-2026': prodPublic })).toEqual({
      ok: false,
      code: 'E_LICENCE_UNKNOWN_KID',
    })
    expect(await activate(result.key ?? '', 1)).toEqual({
      status: 400,
      body: { code: 'E_LICENCE_UNKNOWN_KID' },
    })
    const deactivate = await post('/deactivate', { key: result.key, device: device(1) })
    expect(await deactivate.json()).toEqual({ code: 'E_LICENCE_UNKNOWN_KID' })
  })

  it("stores Apple's original purchase date, and none when Apple's answer has none", async () => {
    const purchasedAt = async () =>
      (
        await db.prepare('SELECT purchased_at FROM app_store_licences').first<{
          purchased_at: string | null
        }>()
      )?.purchased_at
    expect((await exchange((await bought()).jws)).status).toBe(200)
    expect(await purchasedAt()).toBe('2026-11-01T00:00:00Z')
    await db.prepare('DELETE FROM app_store_licences').run()
    for (const originalPurchaseDate of [undefined, 'yesterday', 9e15]) {
      expect((await exchange((await bought({ originalPurchaseDate })).jws)).status).toBe(200)
      expect(await purchasedAt()).toBeNull()
      await db.prepare('DELETE FROM app_store_licences').run()
    }
  })

  it('returns the same key byte for byte when asked again, with one row', async () => {
    const { jws } = await bought()
    const first = await exchange(jws)
    clock = later(3)
    const second = await exchange(jws)
    expect(second).toEqual(first)
    expect(await rows()).toHaveLength(1)
  })

  it('makes one row and one key when exchanges race', async () => {
    const { jws } = await bought()
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => exchange(jws, `198.51.100.${i}`)),
    )
    expect(new Set(results.map((r) => r.key)).size).toBe(1)
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(await rows()).toHaveLength(1)
  })

  it('signs the same licence under the new kid after a key rotation', async () => {
    const { jws } = await bought()
    const first = await exchange(jws)
    app = await build({ kid: 'test' })
    const second = await exchange(jws)
    expect(second.id).toBe(first.id)
    expect(second.key).not.toBe(first.key)
    const verified = await verifyLicence(second.key ?? '', { test: testPublic })
    expect(verified.ok && verified.payload.kid).toBe('test')
  })

  it('caps a leaked JWS at the one licence and its three seats', async () => {
    const { jws } = await bought()
    const own = await exchange(jws, '203.0.113.1')
    const thief = await exchange(jws, '192.0.2.66')
    expect(thief.key).toBe(own.key)
    for (const n of [1, 2, 3]) expect((await activate(own.key ?? '', n)).status).toBe(200)
    expect(await activate(thief.key ?? '', 4)).toEqual({
      status: 409,
      body: { code: 'E_LICENCE_DEVICE_LIMIT' },
    })
  })

  it('refuses a body over 16 KB', async () => {
    const big = JSON.stringify({ transaction: 'x'.repeat(APP_STORE_LIMITS.exchangeBytes) })
    const response = await post('/app-store/exchange', big)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ code: 'E_LICENCE_TOO_LARGE' })
  })
})

describe('rate limits', () => {
  it('allows 30 an hour per IP, counted after the JWS checks out and before Apple', async () => {
    const forged = await signJws(transaction(), await chain())
    for (let i = 0; i < 40; i++) await exchange(forged)
    const trial = await bought({ productId: TRIAL })
    for (let i = 0; i < 40; i++) await exchange(trial.jws)
    expect(apple.calls).toEqual([])
    for (let i = 0; i < APP_STORE_LIMITS.exchangePerIp; i++) {
      const { jws } = await bought({
        transactionId: `30000000000${String(i).padStart(2, '0')}`,
        originalTransactionId: `30000000000${String(i).padStart(2, '0')}`,
      })
      expect((await exchange(jws)).status).toBe(200)
    }
    const { jws } = await bought()
    expect(await exchange(jws)).toMatchObject({ status: 429, code: 'E_LICENCE_RATE_LIMITED' })
    expect(apple.calls).toHaveLength(APP_STORE_LIMITS.exchangePerIp)
    clock = new Date(NOW.getTime() + 3_600_000)
    expect((await exchange(jws)).status).toBe(200)
  })

  it('allows 10 an hour per purchase, and an over-limit IP spends none of it', async () => {
    for (let i = 0; i < APP_STORE_LIMITS.exchangePerIp; i++) {
      const id = `40000000000${String(i).padStart(2, '0')}`
      await exchange(
        (await bought({ transactionId: id, originalTransactionId: id })).jws,
        '192.0.2.1',
      )
    }
    const { jws } = await bought()
    for (let i = 0; i < 20; i++) {
      expect(await exchange(jws, '192.0.2.1')).toMatchObject({ code: 'E_LICENCE_RATE_LIMITED' })
    }
    const answers = []
    for (let i = 0; i < 15; i++) answers.push((await exchange(jws, `198.51.100.${i}`)).status)
    expect(answers.filter((s) => s === 200)).toHaveLength(APP_STORE_LIMITS.exchangePerTransaction)
    expect(answers.slice(APP_STORE_LIMITS.exchangePerTransaction).every((s) => s === 429)).toBe(
      true,
    )
  })
})

describe('notifications', () => {
  it('a REFUND revokes the licence: listed in /revoked, refused by /activate and by a new exchange', async () => {
    const { payload, jws } = await bought()
    const { id, key } = await exchange(jws)
    expect((await activate(key ?? '', 1)).status).toBe(200)
    expect(await notify('REFUND', { ...payload, revocationDate: NOW.getTime() })).toEqual({
      status: 200,
      body: { received: true },
    })
    expect(await revokedList()).toEqual([id])
    expect(await activate(key ?? '', 1)).toEqual({
      status: 410,
      body: { code: 'E_LICENCE_REVOKED' },
    })
    expect(await exchange(jws)).toMatchObject({ status: 410, code: 'E_LICENCE_REVOKED' })
    expect(logs).toContain(`I_APP_STORE_REVOKED ${id} REFUND`)
  })

  it('a REVOKE does the same, and revoking twice is harmless', async () => {
    const { payload, jws } = await bought()
    const { id } = await exchange(jws)
    expect((await notify('REVOKE', payload)).status).toBe(200)
    expect((await notify('REVOKE', payload)).status).toBe(200)
    expect(await revokedList()).toEqual([id])
  })

  it('a refund before any exchange is recorded, so the exchange is refused', async () => {
    const { payload, jws } = await bought()
    expect((await notify('REFUND', payload)).status).toBe(200)
    expect(await exchange(jws)).toMatchObject({ code: 'E_LICENCE_REVOKED' })
    expect(await revokedList()).toEqual([])
  })

  it('an exchange whose Apple answer carries a revocationDate is refused, and recorded', async () => {
    const { jws } = await bought({}, false)
    apple.put(transaction({ revocationDate: NOW.getTime(), revocationReason: 0 }))
    expect(await exchange(jws)).toMatchObject({ code: 'E_LICENCE_REVOKED' })
    apple.put(transaction())
    expect(await exchange(jws)).toMatchObject({ code: 'E_LICENCE_REVOKED' })
  })

  it('a forged notification is answered 401 and changes nothing', async () => {
    const { payload, jws } = await bought()
    const { key } = await exchange(jws)
    const forger = await chain()
    expect((await notify('REFUND', payload, { by: forger })).status).toBe(401)
    expect((await post('/app-store/notifications', { signedPayload: 'a.b.c' })).status).toBe(401)
    expect((await post('/app-store/notifications', { other: 1 })).status).toBe(400)
    expect((await post('/app-store/notifications', 'nope')).status).toBe(400)
    expect((await activate(key ?? '', 1)).status).toBe(200)
    expect(await revokedList()).toEqual([])
  })

  it("a notification for another bundle, or whose transaction's environment differs, is 401", async () => {
    const { payload, jws } = await bought()
    await exchange(jws)
    expect(
      (await notify('REFUND', payload, { data: { bundleId: 'com.example.other' } })).status,
    ).toBe(401)
    expect((await notify('REFUND', payload, { data: { environment: 'Sandbox' } })).status).toBe(401)
    expect((await notify('REFUND', { ...payload, bundleId: 'com.example.other' })).status).toBe(401)
    expect((await notify('REFUND', payload, { data: { environment: 'Xcode' } })).status).toBe(401)
    expect(await revokedList()).toEqual([])
  })

  it('a sandbox refund never touches the production licence of the same purchase', async () => {
    const production = await bought()
    const sandbox = await bought({ environment: 'Sandbox' })
    const prod = await exchange(production.jws)
    const box = await exchange(sandbox.jws)
    expect(prod.id).not.toBe(box.id)
    expect(await rows()).toHaveLength(2)
    expect((await notify('REFUND', sandbox.payload)).status).toBe(200)
    expect(await revokedList()).toEqual([])
    expect((await activate(prod.key ?? '', 1)).status).toBe(200)
    expect((await exchange(production.jws)).key).toBe(prod.key)
    expect(await exchange(sandbox.jws)).toMatchObject({ code: 'E_LICENCE_REVOKED' })
  })

  it('a replayed notification does nothing once the owner restored the licence', async () => {
    const { payload, jws } = await bought()
    const { id, key } = await exchange(jws)
    const uuid = crypto.randomUUID()
    expect((await notify('REFUND', payload, { uuid })).status).toBe(200)
    expect((await notify('REFUND_REVERSED', payload)).status).toBe(200)
    expect(await revokedList()).toEqual([id])
    expect(logs).toContain(`I_APP_STORE_REFUND_REVERSED ${id}`)
    await db
      .prepare('UPDATE app_store_licences SET revoked_at = NULL WHERE licence_id = ?')
      .bind(id)
      .run()
    expect((await notify('REFUND', payload, { uuid })).status).toBe(200)
    expect(await revokedList()).toEqual([])
    expect((await activate(key ?? '', 1)).status).toBe(200)
    expect(logs).toContain('I_APP_STORE_REPLAYED')
  })

  it('a REFUND_REVERSED arriving first changes nothing, and the later REFUND still revokes', async () => {
    const { payload, jws } = await bought()
    const { id } = await exchange(jws)
    expect((await notify('REFUND_REVERSED', payload)).status).toBe(200)
    expect(await revokedList()).toEqual([])
    expect((await notify('REFUND', payload)).status).toBe(200)
    expect(await revokedList()).toEqual([id])
  })

  it('TEST, other types and other products answer 200 and change nothing', async () => {
    const { payload, jws } = await bought()
    await exchange(jws)
    for (const type of ['TEST', 'CONSUMPTION_REQUEST', 'EXTERNAL_PURCHASE_TOKEN']) {
      expect((await notify(type, payload)).status).toBe(200)
    }
    expect((await notify('REFUND', { ...payload, productId: TRIAL })).status).toBe(200)
    expect(await rows()).toHaveLength(1)
    expect(await revokedList()).toEqual([])
  })

  it('takes a notification over 16 KB, as one carrying renewal info may be', async () => {
    const { payload, jws } = await bought()
    const { id } = await exchange(jws)
    const result = await notify(
      'REFUND',
      { ...payload, revocationDate: NOW.getTime() },
      { data: { signedRenewalInfo: 'x'.repeat(20 * 1024) } },
    )
    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(await revokedList()).toEqual([id])
  })

  it('refuses a body over 64 KB, and answers 500 when the write fails so Apple retries', async () => {
    const big = JSON.stringify({ signedPayload: 'x'.repeat(APP_STORE_LIMITS.notificationBytes) })
    expect((await post('/app-store/notifications', big)).status).toBe(413)
    const { payload } = await bought()
    await db.prepare('DROP TABLE app_store_notifications').run()
    try {
      expect((await notify('REFUND', payload)).status).toBe(500)
    } finally {
      await db
        .prepare(
          'CREATE TABLE app_store_notifications (notification_uuid TEXT PRIMARY KEY, received_at TEXT NOT NULL)',
        )
        .run()
    }
    expect(await rows()).toEqual([])
  })
})

describe('the renewal check at /activate', () => {
  async function exchanged() {
    const { payload, jws } = await bought()
    const result = await exchange(jws)
    apple.calls.length = 0
    return { payload, key: result.key ?? '', id: result.id ?? '' }
  }

  it('asks Apple at most once per licence a day, and never before a seat is granted', async () => {
    const { key } = await exchanged()
    for (const n of [1, 2, 3]) expect((await activate(key, n)).status).toBe(200)
    expect(apple.calls).toEqual([])
    clock = later(2)
    for (let n = 4; n < 40; n++) expect((await activate(key, n)).status).toBe(409)
    expect(apple.calls).toEqual([])
    for (const n of [1, 2, 3, 1, 2]) expect((await activate(key, n)).status).toBe(200)
    expect(apple.calls).toHaveLength(1)
    clock = later(2.9)
    expect((await activate(key, 1)).status).toBe(200)
    expect(apple.calls).toHaveLength(1)
    clock = later(3)
    expect((await activate(key, 1)).status).toBe(200)
    expect(apple.calls).toHaveLength(2)
  })

  it('a revocationDate revokes the licence and refuses without a lease', async () => {
    const { payload, key, id } = await exchanged()
    clock = later(2)
    apple.put({ ...payload, revocationDate: NOW.getTime() })
    expect(await activate(key, 1)).toEqual({ status: 410, body: { code: 'E_LICENCE_REVOKED' } })
    expect(await revokedList()).toEqual([id])
    expect(logs).toContain(`I_APP_STORE_REVOKED ${id} RENEWAL`)
  })

  it('a 404 refuses without a lease and logs E_APP_STORE_NOT_FOUND', async () => {
    const { key, id } = await exchanged()
    clock = later(2)
    apple.transactions.clear()
    expect(await activate(key, 1)).toEqual({ status: 404, body: { code: 'E_APP_STORE_NOT_FOUND' } })
    expect(logs).toContain(`E_APP_STORE_NOT_FOUND ${id}`)
  })

  it("a refusal stands for every device until Apple's next good answer, still one call a day", async () => {
    const { payload, key } = await exchanged()
    const otherChain = await chain()
    const refusals: [string, number, () => void][] = [
      ['E_APP_STORE_NOT_FOUND', 404, () => apple.transactions.clear()],
      [
        'E_APP_STORE_MISMATCH',
        409,
        () => apple.put({ ...payload, originalTransactionId: '2000000000000077' }),
      ],
      ['E_APP_STORE_UPSTREAM', 503, () => (signing = otherChain)],
    ]
    const real = signing
    let day = 2
    for (const [code, status, refuse] of refusals) {
      clock = later(day)
      apple.calls.length = 0
      refuse()
      const refused = { status, body: { code } }
      expect(await activate(key, 1)).toEqual(refused)
      apple.transactions.clear()
      apple.put(payload)
      signing = real
      expect(await activate(key, 1)).toEqual(refused)
      expect(await activate(key, 2)).toEqual(refused)
      clock = later(day + 0.9)
      expect(await activate(key, 3)).toEqual(refused)
      expect(apple.calls).toHaveLength(1)
      clock = later(day + 1)
      for (const n of [1, 2, 3]) expect((await activate(key, n)).status).toBe(200)
      expect(apple.calls).toHaveLength(2)
      day += 2
    }
  })

  it('a standing refusal is kept while Apple cannot be reached, and a new exchange clears it', async () => {
    const { payload, key } = await exchanged()
    const jws = await signJws(payload, signing)
    clock = later(2)
    apple.transactions.clear()
    expect((await activate(key, 1)).status).toBe(404)
    clock = later(3)
    apple.failure = 503
    expect(await activate(key, 1)).toEqual({ status: 404, body: { code: 'E_APP_STORE_NOT_FOUND' } })
    apple.failure = null
    apple.put(payload)
    expect((await exchange(jws)).status).toBe(200)
    expect((await activate(key, 1)).status).toBe(200)
  })

  it('a family-shared or mismatched answer refuses without a lease', async () => {
    const { payload, key } = await exchanged()
    clock = later(2)
    apple.put({ ...payload, inAppOwnershipType: 'FAMILY_SHARED' })
    expect((await activate(key, 1)).status).toBe(403)
    clock = later(4)
    apple.put({ ...payload, originalTransactionId: '2000000000000077' })
    expect((await activate(key, 1)).status).toBe(409)
  })

  it('only a network failure, a 5xx or a 429 issues the lease, and logs E_APP_STORE_UNREACHABLE', async () => {
    const { key, id } = await exchanged()
    let day = 2
    for (const failure of [429, 500, 502, 'network'] as const) {
      clock = later(day++)
      apple.failure = failure
      const result = await activate(key, 1)
      expect(result.status).toBe(200)
      const lease = await verifyActivation(String(result.body['lease']), {
        'prod-2026': prodPublic,
      })
      expect(lease.ok).toBe(true)
    }
    expect(logs.filter((l) => l.startsWith(`E_APP_STORE_UNREACHABLE ${id}`))).toHaveLength(4)
    clock = later(day++)
    apple.failure = 400
    expect((await activate(key, 1)).status).toBe(404)
  })

  it('sets checked_at at every attempt, whatever Apple answers', async () => {
    const { key } = await exchanged()
    clock = later(2)
    apple.failure = 503
    await activate(key, 1)
    await activate(key, 1)
    apple.failure = null
    apple.transactions.clear()
    expect((await activate(key, 1)).status).toBe(200)
    expect(apple.calls).toHaveLength(1)
  })

  it('a Stripe licence never asks Apple', async () => {
    const signer = await signerFromSeed('prod-2026', prodSeed)
    await d1Store(db).issue({
      sessionId: 'cs_test_stripe',
      licenceId: 'SSSSSSSSSSSSSSSSSSSSSS',
      customerId: 'cus_1',
      paymentIntent: null,
      at: '2026-11-01T00:00:00Z',
    })
    const { signLicence } = await import('../../licence/src/format')
    const key = await signLicence(signer, {
      id: 'SSSSSSSSSSSSSSSSSSSSSS',
      licensee: 'buyer@example.com',
      issuedAt: '2026-11-01T00:00:00Z',
    })
    clock = later(5)
    expect((await activate(key, 1)).status).toBe(200)
    expect(apple.calls).toEqual([])
  })
})

describe('without the App Store settings', () => {
  it('the App Store routes answer E_LICENCE_CONFIG and an App Store licence still renews', async () => {
    const { jws } = await bought()
    const { key } = await exchange(jws)
    app = await build({ appStore: false })
    expect(await exchange(jws)).toEqual({ status: 503, code: 'E_LICENCE_CONFIG' })
    const notification = await post('/app-store/notifications', { signedPayload: jws })
    expect(notification.status).toBe(503)
    clock = later(2)
    expect((await activate(key ?? '', 1)).status).toBe(200)
    expect((await app(new Request(`${ORIGIN}/revoked`))).status).toBe(200)
  })

  it('every App Store route takes POST only', async () => {
    for (const path of ['/app-store/exchange', '/app-store/notifications']) {
      expect((await app(new Request(`${ORIGIN}${path}`))).status).toBe(405)
    }
  })
})

describe('/devices?from=app', () => {
  const links = (html: string) => [...html.matchAll(/(?:href|action)="([^"]*)"/g)].map((m) => m[1])
  const appLinks = (html: string) => {
    expect(html).not.toMatch(/devot\.online|\/buy/)
    for (const link of links(html)) {
      expect(link === '/devices?from=app' || link?.startsWith('/assets/')).toBe(true)
    }
  }
  const form = (body: Record<string, string>, path = '/devices?from=app') =>
    app(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        body: new URLSearchParams(body).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    )

  it('serves the page, its form posts and its errors with no link outside /devices', async () => {
    const { jws } = await bought()
    const { key } = await exchange(jws)
    await activate(key ?? '', 1)
    const page = await app(new Request(`${ORIGIN}/devices?from=app`))
    appLinks(await page.text())
    const listed = await form({ key: key ?? '' })
    const listedHtml = await listed.text()
    expect(listedHtml).toContain(device(1))
    appLinks(listedHtml)
    const removed = await form({ key: key ?? '', device: device(1) })
    appLinks(await removed.text())
    for (const response of [
      await form({ key: 'devot1.nope.nope' }),
      await form({ key: key ?? '', device: 'bad' }),
      await app(new Request(`${ORIGIN}/devices?from=app`, { method: 'PUT' })),
    ]) {
      expect(response.status).toBeGreaterThanOrEqual(400)
      appLinks(await response.text())
    }
  })

  it('without the flag, the page keeps its links to the website', async () => {
    const page = await (await app(new Request(`${ORIGIN}/devices`))).text()
    expect(page).toContain('https://devot.online')
    expect(links(page)).toContain('/devices')
    const error = await (await form({ key: 'x' }, '/devices')).text()
    expect(error).toContain('https://devot.online')
  })
})

// Last in the file, so it sees every line the tests above logged.
it('logs no JWS, transaction ID or key, only codes and licence IDs', () => {
  expect(allLogs.length).toBeGreaterThan(50)
  expect(secrets.size).toBeGreaterThan(50)
  const leaked = allLogs.filter((line) => [...secrets].some((secret) => line.includes(secret)))
  expect(leaked).toEqual([])
  expect(allLogs.every((line) => /^[EI]_[A-Z_]+( [A-Za-z0-9_-]+)*$/.test(line))).toBe(true)
})
