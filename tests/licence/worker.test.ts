import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare, type Request as WorkerRequest } from 'miniflare'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fromBase64Url, verifyRevocations } from '../../licence/src/format'
import type { SqlDatabase } from '../../licence/src/store'
import { STRIPE_VERSION } from '../../licence/src/stripe'
import { migrate, vectors } from './support'

// The bundled Worker in workerd through Miniflare, from the same entry and settings as
// licence/wrangler.toml, with D1 in memory and Stripe answered here: nothing is deployed and
// nothing reaches Stripe. It sends no mail.

const wrangler = readFileSync('licence/wrangler.toml', 'utf8')
const setting = (key: string) => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(wrangler)?.[1]
const testKey = vectors.keys[0]
const publicKeys = {
  test: fromBase64Url(testKey?.publicKey ?? '') ?? new Uint8Array(),
}
const secrets = {
  LICENCE_KID: 'test',
  LICENCE_SIGNING_KEY: testKey?.seed ?? '',
  STRIPE_SECRET_KEY: 'rk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_PRICE_LICENCE: 'price_licence',
  STRIPE_PRICE_RENEWAL: 'price_renewal',
  MANAGED_PAYMENTS: 'true',
  MAIL_FROM: 'licence@devot.test',
  RESEND_API_KEY: 're_test_fake',
}

const stripeCalls: {
  url: string
  headers: Record<string, string>
  body: string
}[] = []
let script = ''
let mf: Miniflare
let url = ''

function worker(bindings: Record<string, string>) {
  return new Miniflare({
    name: setting('name') ?? '',
    modules: true,
    script,
    compatibilityDate: setting('compatibility_date') ?? '',
    d1Databases: { DB: 'licence-worker-test' },
    bindings,
    outboundService: async (request: WorkerRequest) => {
      stripeCalls.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
      return Response.json({
        object: 'checkout.session',
        id: 'cs_test_worker',
        url: 'https://checkout.stripe.test/cs_test_worker',
      })
    },
    host: '127.0.0.1',
    port: 0,
  })
}

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [`licence/${setting('main')}`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  })
  script = bundle.outputFiles[0]?.text ?? ''
  mf = worker(secrets)
  url = (await mf.ready).toString().replace(/\/$/, '')
  await migrate((await mf.getD1Database('DB')) as unknown as SqlDatabase)
})
afterAll(() => mf.dispose())

it('wrangler.toml binds D1 with its migrations and no email binding, as the tests run them', () => {
  expect(setting('main')).toBe('src/worker.ts')
  expect(wrangler).toMatch(
    /\[\[d1_databases\]\]\nbinding = "DB"\ndatabase_name = "devot-licence"\nmigrations_dir = "migrations"/,
  )
  expect(wrangler).not.toMatch(/send_email/)
  const owners = [
    'LICENCE_KID',
    'STRIPE_PRICE_LICENCE',
    'STRIPE_PRICE_RENEWAL',
    'MAIL_FROM',
    'REPLY_TO',
  ]
  expect(owners.map((name) => [name, setting(name)])).toEqual(owners.map((name) => [name, '']))
  expect(setting('MANAGED_PAYMENTS')).toBe('true')
  expect(wrangler).not.toMatch(/SIGNING_KEY = |SECRET_KEY = |WEBHOOK_SECRET = /)
})

it('serves the signed revocation list from D1', async () => {
  const db = (await mf.getD1Database('DB')) as unknown as SqlDatabase
  await db.batch([
    db
      .prepare(
        `INSERT INTO licences (id, session_id, customer_id, issued_at, updates_until, revoked_at)
         VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'cs_1', 'cus_1', '2026-10-24T00:00:00Z', '2027-10-24', '2026-11-01T00:00:00Z'),
                ('BBBBBBBBBBBBBBBBBBBBBB', 'cs_2', 'cus_2', '2026-10-24T00:00:00Z', '2027-10-24', NULL)`,
      )
      .bind(),
  ])
  const response = await fetch(`${url}/revoked`)
  expect(response.status).toBe(200)
  const result = await verifyRevocations(await response.text(), publicKeys)
  expect(result.ok && result.payload.ids).toEqual(['AAAAAAAAAAAAAAAAAAAAAA'])
})

it('creates a Checkout Session through the Stripe client and redirects to it', async () => {
  const response = await fetch(`${url}/buy`, { redirect: 'manual' })
  expect(response.status).toBe(303)
  expect(response.headers.get('Location')).toBe('https://checkout.stripe.test/cs_test_worker')
  const call = stripeCalls.at(-1)
  expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions')
  expect(call?.headers['authorization']).toBe('Bearer rk_test_fake')
  expect(call?.headers['stripe-version']).toBe(STRIPE_VERSION)
  const form = new URLSearchParams(call?.body)
  expect(form.get('managed_payments[enabled]')).toBe('true')
  expect(form.get('success_url')).toBe(`${url}/done?session_id={CHECKOUT_SESSION_ID}`)
})

it('refuses an unsigned webhook and an unknown renewal', async () => {
  const webhook = await fetch(`${url}/stripe/webhook`, {
    method: 'POST',
    body: '{}',
  })
  expect(webhook.status).toBe(400)
  expect(await webhook.json()).toEqual({ code: 'E_LICENCE_WEBHOOK_SIGNATURE' })
  const renew = await fetch(`${url}/renew?licence=CCCCCCCCCCCCCCCCCCCCCC`)
  expect(renew.status).toBe(404)
  expect(await renew.text()).toContain('E_LICENCE_UNKNOWN')
})

it('answers E_LICENCE_CONFIG when RESEND_API_KEY is missing', async () => {
  const bare = worker({ ...secrets, RESEND_API_KEY: '' })
  try {
    const response = await fetch(`${(await bare.ready).toString().replace(/\/$/, '')}/revoked`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('E_LICENCE_CONFIG')
  } finally {
    await bare.dispose()
  }
})

it('answers E_LICENCE_CONFIG until the secrets are set', async () => {
  const bare = worker({
    ...secrets,
    LICENCE_SIGNING_KEY: '',
    STRIPE_SECRET_KEY: '',
  })
  try {
    const bareUrl = (await bare.ready).toString().replace(/\/$/, '')
    const response = await fetch(`${bareUrl}/revoked`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('E_LICENCE_CONFIG')
  } finally {
    await bare.dispose()
  }
})
