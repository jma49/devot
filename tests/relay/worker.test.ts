import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { ANONYMOUS_BURST } from '../../relay/src/front'
import { postJson, randomId } from './client'
import { relaySuite } from './suite'

// The Cloudflare host runs locally in workerd through Miniflare, bundled from
// the same entry and settings as relay/wrangler.toml; nothing is deployed.

const secret = 'test-relay-secret-0123456789abcdef'
const wrangler = readFileSync('relay/wrangler.toml', 'utf8')
const setting = (key: string) => new RegExp(`^${key} = "([^"]+)"$`, 'm').exec(wrangler)?.[1]

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
})

async function startWorker() {
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
    host: '127.0.0.1',
    port: 0,
  })
  const url = (await mf.ready).toString().replace(/\/$/, '')
  return { url, secret, close: () => mf.dispose() }
}

relaySuite('a Durable Object (Miniflare)', startWorker)

it('refuses a burst of the routes anyone may call before they reach a Durable Object', async () => {
  const host = await startWorker()
  try {
    const take = (from: string) =>
      postJson(
        `${host.url}/v1/pairings/${randomId()}/take`,
        { v: 1, type: 'take' },
        { 'cf-connecting-ip': from },
      )
    for (let n = 0; n < ANONYMOUS_BURST; n += 1) {
      expect((await take('192.0.2.1')).status).toBe(404)
    }
    const refused = await take('192.0.2.1')
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
    expect((await take('192.0.2.2')).status).toBe(404)
  } finally {
    await host.close()
  }
})
