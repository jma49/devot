import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, LIMITS } from '../../licence/src/app'
import {
  fromBase64Url,
  type LicencePayload,
  signerFromSeed,
  verifyLicence,
  verifyRevocations,
} from '../../licence/src/format'
import { PENDING_CHECKS } from '../../licence/src/pages'
import { d1Store, type SqlDatabase } from '../../licence/src/store'
import { signStripePayload } from '../../licence/src/webhook'
import { d1Database, FakeStripe, rawSession, RecordingMailer, vectors } from './support'

// The Worker's routes on a real D1 database, with Stripe and the mailer faked: nothing leaves the
// machine. tests/licence/worker.test.ts runs the bundled Worker itself.

const ORIGIN = 'https://licence.test'
const WEBHOOK_SECRET = 'whsec_test_secret'
const testKey = vectors.keys[0]
const seed = fromBase64Url(testKey?.seed ?? '') ?? new Uint8Array()
const publicKeys = { test: fromBase64Url(testKey?.publicKey ?? '') ?? new Uint8Array() }

let db: SqlDatabase
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await d1Database())
})
afterAll(() => close())

let stripe: FakeStripe
let mailer: RecordingMailer
let clock: Date
let pending: Promise<unknown>[]
let logs: string[]
let managedPayments: boolean
let app: (request: Request) => Promise<Response>

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM purchases'),
    db.prepare('DELETE FROM licences'),
    db.prepare('DELETE FROM rate_limits'),
    db.prepare('DELETE FROM revoked_payments'),
  ])
  stripe = new FakeStripe()
  mailer = new RecordingMailer()
  clock = new Date('2026-10-24T09:30:00Z')
  pending = []
  logs = []
  managedPayments = true
  app = await build()
})

async function build() {
  return createApp({
    store: d1Store(db),
    stripe,
    mailer,
    signer: await signerFromSeed('test', seed),
    config: {
      managedPayments,
      priceLicence: 'price_licence',
      cancelUrl: undefined,
      webhookSecret: WEBHOOK_SECRET,
    },
    rateSecret: new Uint8Array(32).fill(1),
    defer: (work) => pending.push(work),
    now: () => clock,
    log: (line) => logs.push(line),
  })
}

async function settle() {
  while (pending.length) await pending.shift()
}

const get = (path: string, headers: Record<string, string> = {}) =>
  app(new Request(`${ORIGIN}${path}`, { headers }))

async function webhook(type: string, object: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify({ id: `evt_${type}`, type, data: { object } })
  const signature = await signStripePayload(body, secret, Math.floor(clock.getTime() / 1000))
  return app(
    new Request(`${ORIGIN}/stripe/webhook`, {
      method: 'POST',
      body,
      headers: { 'Stripe-Signature': signature },
    }),
  )
}

const resend = (email: string, ip = '203.0.113.1') =>
  app(
    new Request(`${ORIGIN}/resend`, {
      method: 'POST',
      body: new URLSearchParams({ email }).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'CF-Connecting-IP': ip,
      },
    }),
  )

/** /buy, then the buyer pays: the session as Stripe has it afterwards. */
async function buy(email: string) {
  const response = await get('/buy')
  expect(response.status).toBe(303)
  const sessionId = response.headers.get('Location')?.split('/').pop() ?? ''
  return stripe.pay(sessionId, email)
}

async function payload(key: string): Promise<LicencePayload> {
  const result = await verifyLicence(key, publicKeys)
  if (!result.ok) throw new Error(result.code)
  return result.payload
}

const keysIn = (text: string) => [
  ...new Set(text.match(/devot1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []),
]
const licenceCount = async () =>
  (await db.prepare('SELECT count(*) AS n FROM licences').first<{ n: number }>())?.n

describe('buying', () => {
  it('/buy redirects to a Checkout Session with Managed Payments', async () => {
    const response = await get('/buy')
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('https://checkout.stripe.test/cs_test_1')
    expect(stripe.created[0]).toMatchObject({
      mode: 'payment',
      'line_items[0][price]': 'price_licence',
      customer_creation: 'always',
      success_url: `${ORIGIN}/done?session_id={CHECKOUT_SESSION_ID}`,
      'managed_payments[enabled]': 'true',
      'metadata[kind]': 'licence',
    })
  })

  it('/buy uses Stripe Tax when the variable turns Managed Payments off', async () => {
    managedPayments = false
    app = await build()
    await get('/buy')
    expect(stripe.created[0]?.['automatic_tax[enabled]']).toBe('true')
    expect(stripe.created[0]?.['managed_payments[enabled]']).toBeUndefined()
  })

  it('issues and mails one licence per paid session, whatever Stripe retries', async () => {
    const session = await buy('buyer@example.com')
    const event = rawSession(session)
    expect((await webhook('checkout.session.completed', event)).status).toBe(200)
    expect((await webhook('checkout.session.completed', event)).status).toBe(200)
    expect(await licenceCount()).toBe(1)
    expect(mailer.sent).toHaveLength(1)
    const [mail] = mailer.sent
    expect(mail?.to).toBe('buyer@example.com')
    expect(mail?.idempotencyKey).toBe(`issued/${session.id}`)
    const [key] = keysIn(mail?.text ?? '')
    const licence = await payload(key ?? '')
    expect(Object.keys(licence)).toEqual(['id', 'kid', 'plan', 'licensee', 'issuedAt'])
    expect(licence).toMatchObject({
      kid: 'test',
      plan: 'pro',
      licensee: 'buyer@example.com',
      issuedAt: '2026-10-24T09:30:00Z',
    })
    expect(mail?.subject).toBe('Your Devot licence')
    expect(mail?.text).toContain(
      'A licence unlocks all of Devot, editing, sync and AI, in every version of Devot',
    )
    expect(mail?.text).toContain(`devot://licence?key=${encodeURIComponent(key ?? '')}`)
    expect(mail?.html).toContain(`href="devot://licence?key=${encodeURIComponent(key ?? '')}"`)
  })

  it('waits for an asynchronous payment to succeed', async () => {
    const session = await buy('buyer@example.com')
    const unpaid = { ...rawSession(session), payment_status: 'unpaid' }
    await webhook('checkout.session.completed', unpaid)
    expect(await licenceCount()).toBe(0)
    await webhook('checkout.session.async_payment_succeeded', rawSession(session))
    expect(await licenceCount()).toBe(1)
  })

  it('leaves alone a session this Worker did not create', async () => {
    for (const metadata of [{}, { kind: 'renewal', licence: 'AAAAAAAAAAAAAAAAAAAAAA' }]) {
      const session = await buy('buyer@example.com')
      const foreign = { ...session, metadata }
      stripe.sessions.set(session.id, foreign)
      expect((await webhook('checkout.session.completed', rawSession(foreign))).status).toBe(200)
      expect((await get(`/done?session_id=${session.id}`)).status).toBe(404)
    }
    expect(await licenceCount()).toBe(0)
    expect(mailer.sent).toEqual([])
  })

  it('refuses a webhook with a bad signature', async () => {
    const session = await buy('buyer@example.com')
    const response = await webhook('checkout.session.completed', rawSession(session), 'whsec_x')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'E_LICENCE_WEBHOOK_SIGNATURE' })
    expect(await licenceCount()).toBe(0)
  })

  it('answers 500 when the mail fails, so Stripe retries and the mail goes once', async () => {
    const event = rawSession(await buy('buyer@example.com'))
    mailer.failing = true
    const failed = await webhook('checkout.session.completed', event)
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ code: 'E_LICENCE_MAIL' })
    mailer.failing = false
    expect((await webhook('checkout.session.completed', event)).status).toBe(200)
    expect((await webhook('checkout.session.completed', event)).status).toBe(200)
    expect(await licenceCount()).toBe(1)
    expect(mailer.sent).toHaveLength(1)
  })

  it('refuses a body larger than a webhook can be', async () => {
    const response = await app(
      new Request(`${ORIGIN}/stripe/webhook`, {
        method: 'POST',
        body: 'x'.repeat(LIMITS.webhookBytes + 1),
      }),
    )
    expect(response.status).toBe(413)
  })
})

describe('/done', () => {
  it('issues the licence itself when the buyer arrives before the webhook', async () => {
    const session = await buy('buyer@example.com')
    const response = await get(`/done?session_id=${session.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const html = await response.text()
    const [key] = keysIn(html)
    expect((await payload(key ?? '')).licensee).toBe('buyer@example.com')
    expect(html).toContain(`href="devot://licence?key=${encodeURIComponent(key ?? '')}"`)
    expect(html).toContain('Open in Devot')
    expect(html).toContain(
      'A licence unlocks all of Devot, editing, sync and AI, in every version of Devot',
    )
    await settle()
    expect(mailer.sent).toHaveLength(1)
    await webhook('checkout.session.completed', rawSession(session))
    expect(await licenceCount()).toBe(1)
    expect(mailer.sent).toHaveLength(1)
    expect(keysIn(mailer.sent[0]?.text ?? '')[0]).toBe(key)
  })

  it('mails once when the webhook arrives while /done is still sending', async () => {
    const session = await buy('buyer@example.com')
    const release = mailer.hold()
    expect((await get(`/done?session_id=${session.id}`)).status).toBe(200)
    // A webhook that also sent would wait on the held mail, so the test would time out.
    const hooks = [1, 2].map(() => webhook('checkout.session.completed', rawSession(session)))
    expect((await Promise.all(hooks)).map((r) => r.status)).toEqual([200, 200])
    release()
    await settle()
    expect(mailer.sent).toHaveLength(1)
  })

  it('leaves the mail to the webhook when the mail from /done fails', async () => {
    const session = await buy('buyer@example.com')
    mailer.failing = true
    await get(`/done?session_id=${session.id}`)
    await settle()
    expect(logs).toContain(`E_LICENCE_MAIL ${session.id} E_DELIVERY_FAILED`)
    mailer.failing = false
    expect((await webhook('checkout.session.completed', rawSession(session))).status).toBe(200)
    expect(mailer.sent).toHaveLength(1)
  })

  it("signs for the session's address when the first customer is gone, and says when no address is left", async () => {
    const session = await buy('buyer@example.com')
    await webhook('checkout.session.completed', rawSession(session))
    const mailed = keysIn(mailer.sent[0]?.text ?? '')[0]
    stripe.customers.delete(session.customer ?? '')
    const html = await (await get(`/done?session_id=${session.id}`)).text()
    expect(keysIn(html)[0]).toBe(mailed)
    stripe.sessions.set(session.id, { ...session, email: null })
    const response = await get(`/done?session_id=${session.id}`)
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('E_LICENCE_NO_CUSTOMER')
  })

  it('shows the same key again after the webhook issued it', async () => {
    const session = await buy('buyer@example.com')
    await webhook('checkout.session.completed', rawSession(session))
    const mailed = keysIn(mailer.sent[0]?.text ?? '')[0]
    stripe.sessions.delete(session.id)
    const html = await (await get(`/done?session_id=${session.id}`)).text()
    expect(keysIn(html)[0]).toBe(mailed)
  })

  it('says a payment is pending, and refuses unknown or malformed sessions', async () => {
    const response = await get('/buy')
    const sessionId = response.headers.get('Location')?.split('/').pop() ?? ''
    stripe.pay(sessionId, 'buyer@example.com', 'unpaid')
    expect((await get(`/done?session_id=${sessionId}`)).status).toBe(202)
    expect(await licenceCount()).toBe(0)
    const refresh = 'http-equiv="refresh"'
    expect(await (await get(`/done?session_id=${sessionId}&check=1`)).text()).toContain(refresh)
    for (const check of [String(PENDING_CHECKS), '99999999999999999999']) {
      const waiting = await get(`/done?session_id=${sessionId}&check=${check}`)
      expect(waiting.status).toBe(202)
      expect(await waiting.text()).not.toContain(refresh)
    }
    for (const check of ['-1', 'x', '', '1e3']) {
      const waiting = await get(`/done?session_id=${sessionId}&check=${check}`)
      expect(await waiting.text()).toContain('check=1"')
    }
    expect((await get('/done?session_id=cs_test_none')).status).toBe(404)
    expect((await get('/done?session_id=<script>')).status).toBe(400)
    expect((await get('/done')).status).toBe(400)
  })

  it('reports a Stripe outage with its code', async () => {
    stripe.failing = true
    const response = await get('/done?session_id=cs_test_9')
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('E_LICENCE_STRIPE')
  })
})

describe('revocation', () => {
  async function issued(email = 'buyer@example.com') {
    const session = await buy(email)
    await webhook('checkout.session.completed', rawSession(session))
    const licence = await payload(keysIn(mailer.sent.at(-1)?.text ?? '')[0] ?? '')
    return { session, licence }
  }

  async function revokedIds() {
    const response = await get('/revoked')
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    const result = await verifyRevocations(await response.text(), publicKeys)
    if (!result.ok) throw new Error(result.code)
    expect(result.payload.issuedAt).toBe('2026-10-24T09:30:00Z')
    return result.payload.ids
  }

  it('a full refund revokes; a partial one does not', async () => {
    const { session, licence } = await issued()
    expect(await revokedIds()).toEqual([])
    const charge = { object: 'charge', payment_intent: session.paymentIntent }
    await webhook('charge.refunded', { ...charge, refunded: false })
    expect(await revokedIds()).toEqual([])
    await webhook('charge.refunded', { ...charge, refunded: true })
    expect(await revokedIds()).toEqual([licence.id])
    const done = await get(`/done?session_id=${session.id}`)
    expect(done.status).toBe(410)
  })

  it('a lost dispute revokes; a won one does not', async () => {
    const a = await issued('a@example.com')
    const b = await issued('b@example.com')
    await webhook('charge.dispute.closed', {
      object: 'dispute',
      status: 'won',
      payment_intent: a.session.paymentIntent,
    })
    await webhook('charge.dispute.closed', {
      object: 'dispute',
      status: 'lost',
      payment_intent: b.session.paymentIntent,
    })
    expect(await revokedIds()).toEqual([b.licence.id])
  })

  it('a refund that arrives before the purchase is recorded issues the licence revoked', async () => {
    const session = await buy('buyer@example.com')
    const refund = await webhook('charge.refunded', {
      object: 'charge',
      refunded: true,
      payment_intent: session.paymentIntent,
    })
    expect(refund.status).toBe(200)
    expect((await webhook('checkout.session.completed', rawSession(session))).status).toBe(200)
    expect(await licenceCount()).toBe(1)
    expect(mailer.sent).toEqual([])
    const [id] = await revokedIds()
    expect(logs).toContain(`E_LICENCE_REVOKED ${id} ${session.id}`)
    expect((await get(`/done?session_id=${session.id}`)).status).toBe(410)
  })

  it('a refund of something else changes nothing', async () => {
    await issued()
    const response = await webhook('charge.refunded', {
      object: 'charge',
      refunded: true,
      payment_intent: 'pi_other',
    })
    expect(response.status).toBe(200)
    expect(await revokedIds()).toEqual([])
  })
})

describe('/resend', () => {
  it('answers the same whether or not the address bought anything', async () => {
    await webhook('checkout.session.completed', rawSession(await buy('buyer@example.com')))
    mailer.sent.length = 0
    const known = await resend('buyer@example.com')
    const unknown = await resend('nobody@example.com', '203.0.113.2')
    expect(known.status).toBe(unknown.status)
    expect(await known.text()).toBe(await unknown.text())
    await settle()
    expect(mailer.sent.map((m) => m.to)).toEqual(['buyer@example.com'])
  })

  it('mails every live licence of every customer with the address, case aside', async () => {
    const one = rawSession(await buy('buyer@example.com'))
    const two = rawSession(await buy('buyer@example.com'))
    const three = await buy('buyer@example.com')
    for (const s of [one, two, rawSession(three)]) await webhook('checkout.session.completed', s)
    await webhook('checkout.session.completed', rawSession(await buy('other@example.com')))
    await webhook('charge.refunded', {
      object: 'charge',
      refunded: true,
      payment_intent: three.paymentIntent,
    })
    mailer.sent.length = 0
    await resend('  Buyer@Example.com ')
    await settle()
    expect(mailer.sent).toHaveLength(1)
    const [mail] = mailer.sent
    expect(mail?.to).toBe('Buyer@Example.com')
    expect(mail?.subject).toBe('Your Devot licences')
    expect(mail?.idempotencyKey).toMatch(/^resend\/address:[0-9a-f]{32}\/1\/\d+$/)
    expect(mail?.idempotencyKey).not.toMatch(/buyer/i)
    const keys = await Promise.all(keysIn(mail?.text ?? '').map(payload))
    expect(keys).toHaveLength(2)
    expect(keys.every((k) => k.licensee === 'buyer@example.com')).toBe(true)
  })

  it('sends at most three a window per address and ten per IP', async () => {
    await webhook('checkout.session.completed', rawSession(await buy('buyer@example.com')))
    mailer.sent.length = 0
    for (let i = 0; i < 4; i++) await resend('buyer@example.com', `198.51.100.${i}`)
    await settle()
    expect(mailer.sent).toHaveLength(LIMITS.resendPerAddress)
    expect(new Set(mailer.sent.map((m) => m.idempotencyKey)).size).toBe(LIMITS.resendPerAddress)
    for (let i = 0; i < 12; i++) await resend(`n${i}@example.com`, '192.0.2.9')
    clock = new Date(clock.getTime() + LIMITS.resendWindowSeconds * 1000)
    await resend('buyer@example.com', '192.0.2.9')
    await settle()
    expect(mailer.sent).toHaveLength(LIMITS.resendPerAddress + 1)
    const { results } = await db.prepare('SELECT key FROM rate_limits').all<{ key: string }>()
    expect(results.some((r) => r.key.includes('example') || r.key.includes('192.0'))).toBe(false)
  })

  it('refuses something that is not an address, and shows its form', async () => {
    expect((await resend('not an address')).status).toBe(400)
    const form = await get('/resend')
    expect(await form.text()).toContain('<form method="post" action="/resend" class="form">')
  })
})

it("serves the pages' stylesheet and copy script from fixed routes", async () => {
  const css = await get('/assets/licence.css')
  expect(css.status).toBe(200)
  expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
  expect((await get('/assets/copy.js')).headers.get('Content-Type')).toBe(
    'text/javascript; charset=utf-8',
  )
  expect((await get('/assets/nothing.css')).status).toBe(404)
})

it('answers unknown paths and methods with their codes', async () => {
  expect((await get('/nothing')).status).toBe(404)
  expect((await get('/__proto__')).status).toBe(404)
  const renew = await get('/renew?licence=AAAAAAAAAAAAAAAAAAAAAA')
  expect(renew.status).toBe(404)
  expect(await renew.text()).toContain('E_LICENCE_NOT_FOUND')
  expect((await get('/stripe/webhook')).status).toBe(405)
  const post = await app(new Request(`${ORIGIN}/buy`, { method: 'POST' }))
  expect(post.status).toBe(405)
  expect(await post.text()).toContain('E_LICENCE_METHOD')
})

it('reports a Stripe outage on /buy with its code', async () => {
  stripe.failing = true
  const response = await get('/buy')
  expect(response.status).toBe(502)
  expect(await response.text()).toContain('E_LICENCE_STRIPE')
  expect(logs).toContain('E_LICENCE_STRIPE 500')
})

it('logs codes and IDs, never an address or a key', async () => {
  const session = await buy('buyer@example.com')
  await get(`/done?session_id=${session.id}`)
  await settle()
  await webhook('checkout.session.completed', rawSession(session))
  await webhook('charge.refunded', {
    object: 'charge',
    refunded: true,
    payment_intent: session.paymentIntent,
  })
  await resend('buyer@example.com')
  mailer.failing = true
  await webhook('checkout.session.completed', rawSession(await buy('second@example.com')))
  await settle()
  expect(logs.length).toBeGreaterThan(3)
  for (const line of logs) {
    expect(line).toMatch(/^[EI]_LICENCE_[A-Z_]+( [A-Za-z0-9_.-]+)*$/)
    expect(line).not.toMatch(/@|devot1/)
  }
})
