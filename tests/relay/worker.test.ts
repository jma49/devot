import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { ANONYMOUS_BURST, SHARED_PERIOD_MS } from '../../relay/src/front'
import { postJson, randomId } from './client'
import { relaySuite } from './suite'

// The Cloudflare host runs locally in workerd through Miniflare, bundled from
// the same entry and settings as relay/wrangler.toml; nothing is deployed.

const secret = 'test-relay-secret-0123456789abcdef'
const wrangler = readFileSync('relay/wrangler.toml', 'utf8')
const setting = (key: string) => new RegExp(`^${key} = "([^"]+)"$`, 'm').exec(wrangler)?.[1]
const ratelimits = Object.fromEntries(
  [
    ...wrangler.matchAll(
      /\[\[ratelimits\]\]\nname = "(\w+)"\nnamespace_id = "(\d+)"\n\n\[ratelimits\.simple\]\nlimit = (\d+)\nperiod = (\d+)/g,
    ),
  ].map(([, name, namespace, limit, period]) => [
    name!,
    { namespace_id: namespace!, simple: { limit: Number(limit), period: Number(period) as 60 } },
  ]),
)

it('wrangler.toml binds the vault object on SQLite storage, as the tests run it', () => {
  expect(setting('main')).toBe('src/worker.ts')
  expect(wrangler).toMatch(
    /\[\[durable_objects\.bindings\]\]\nname = "VAULTS"\nclass_name = "VaultObject"/,
  )
  expect(wrangler).toMatch(/new_sqlite_classes = \["VaultObject"\]/)
  expect(wrangler).toMatch(
    /\[\[durable_objects\.bindings\]\]\nname = "PAIRINGS"\nclass_name = "PairingObject"/,
  )
  expect(wrangler).toMatch(/tag = "v2"\nnew_sqlite_classes = \["PairingObject"\]/)
  expect(wrangler).not.toMatch(/new_classes/)
  expect(Object.keys(ratelimits).sort()).toEqual(['ANONYMOUS_ALL', 'ANONYMOUS_PER_ADDRESS'])
  expect(new Set(Object.values(ratelimits).map((r) => r.namespace_id)).size).toBe(2)
})

async function startWorker({ shared = true } = {}) {
  const bundle = await build({
    entryPoints: [`relay/${setting('main')}`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    external: ['cloudflare:workers'],
    write: false,
    logLevel: 'silent',
  })
  const mf = new Miniflare({
    name: setting('name') ?? '',
    modules: true,
    script: bundle.outputFiles[0]?.text ?? '',
    compatibilityDate: setting('compatibility_date') ?? '',
    durableObjects: {
      VAULTS: { className: 'VaultObject', useSQLite: true },
      PAIRINGS: { className: 'PairingObject', useSQLite: true },
    },
    bindings: { RELAY_SECRET: secret },
    ...(shared ? { ratelimits } : {}),
    host: '127.0.0.1',
    port: 0,
  })
  const url = (await mf.ready).toString().replace(/\/$/, '')
  return { url, secret, close: () => mf.dispose() }
}

// The suite enrolls and pairs more often in a minute than the shared limits allow; they are tested below.
relaySuite('a Durable Object (Miniflare)', () => startWorker({ shared: false }))

const take = (url: string, from: string) =>
  postJson(
    `${url}/v1/pairings/${randomId()}/take`,
    { v: 1, type: 'take' },
    { 'cf-connecting-ip': from },
  )

it('refuses a burst of the routes anyone may call before they reach a Durable Object', async () => {
  // A relay deployed from a wrangler.toml without the shared limits still has the in-memory one.
  const host = await startWorker({ shared: false })
  try {
    for (let n = 0; n < ANONYMOUS_BURST; n += 1) {
      expect((await take(host.url, '192.0.2.1')).status).toBe(404)
    }
    const refused = await take(host.url, '192.0.2.1')
    expect(refused).toMatchObject({ status: 429, body: { code: 'E_SYNC_RATE' } })
    expect(Number(refused.body['retryAfter'])).toBeGreaterThan(0)
    const enroll = await postJson(
      `${host.url}/v1/vaults/${randomId()}/devices`,
      { v: 1, type: 'enroll', secret: randomId(32), label: 'x' },
      { 'cf-connecting-ip': '192.0.2.1' },
    )
    expect(enroll.status).toBe(429)
    const retire = await postJson(
      `${host.url}/v1/vaults/${randomId()}/retire`,
      { v: 1, type: 'retire', successor: randomId() },
      { 'cf-connecting-ip': '192.0.2.1', authorization: `Bearer ${randomId(32)}` },
    )
    expect(retire.status).toBe(429)
    expect((await take(host.url, '192.0.2.2')).status).toBe(404)
  } finally {
    await host.close()
  }
})

it('shares the limit on those routes across instances, per address', async () => {
  const host = await startWorker()
  try {
    const { limit } = ratelimits['ANONYMOUS_PER_ADDRESS']!.simple
    for (let n = 0; n < limit; n += 1) {
      expect((await take(host.url, '198.51.100.1')).status).toBe(404)
    }
    const refused = await take(host.url, '198.51.100.1')
    expect(refused).toMatchObject({
      status: 429,
      body: { code: 'E_SYNC_RATE', retryAfter: SHARED_PERIOD_MS },
    })
    const enroll = await postJson(
      `${host.url}/v1/vaults/${randomId()}/devices`,
      { v: 1, type: 'enroll', secret: randomId(32), label: 'x' },
      { 'cf-connecting-ip': '198.51.100.1' },
    )
    expect(enroll.status).toBe(429)
    expect((await take(host.url, '198.51.100.2')).status).toBe(404)
  } finally {
    await host.close()
  }
})

it('caps those routes from every address together, so spreading a loop over addresses fails too', async () => {
  const host = await startWorker()
  try {
    const { limit } = ratelimits['ANONYMOUS_ALL']!.simple
    for (let n = 0; n < limit; n += 1) {
      expect((await take(host.url, `203.0.113.${n + 1}`)).status).toBe(404)
    }
    const refused = await take(host.url, '203.0.113.250')
    expect(refused).toMatchObject({ status: 429, body: { code: 'E_SYNC_RATE' } })
    const enroll = await postJson(
      `${host.url}/v1/vaults/${randomId()}/devices`,
      { v: 1, type: 'enroll', secret: randomId(32), label: 'x' },
      { 'cf-connecting-ip': '203.0.113.251' },
    )
    expect(enroll.status).toBe(429)
  } finally {
    await host.close()
  }
})
