import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
import { ANONYMOUS_BURST, SHARED_PERIOD_MS } from '../../relay/src/front'
import { ORPHAN_AGE_MS } from '../../relay/src/vault'
import {
  bytes,
  connect,
  createVault,
  enrolled,
  postJson,
  randomId,
  retireVault,
  socketProtocols,
  socketUrl,
  TestSocket,
} from './client'
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

// workerd's clock and alarms cannot be moved from outside, so this entry adds a clock the test
// moves and runs an alarm on demand, as workerd does: the alarm is cleared and the object may be fresh.
const clockedEntry = `
import worker, { PairingObject, VaultObject as Vault } from './${setting('main')}'
let offset = 0
const realNow = Date.now
Date.now = () => realNow() + offset
export class VaultObject extends Vault {
  async advance(ms) { offset += ms }
  async alarmAt() { return this.ctx.storage.getAlarm() }
  async forgetAlarm() { await this.ctx.storage.deleteAlarm() }
  async runAlarm() {
    await this.ctx.storage.deleteAlarm()
    this.relay = undefined
    await this.alarm()
  }
}
export { PairingObject }
export default worker
`

interface ClockedVault {
  advance(ms: number): Promise<void>
  alarmAt(): Promise<number | null>
  forgetAlarm(): Promise<void>
  runAlarm(): Promise<void>
}

async function startWorker({ shared = true, clocked = false } = {}) {
  const bundle = await build({
    ...(clocked
      ? { stdin: { contents: clockedEntry, resolveDir: resolve('relay'), loader: 'js' as const } }
      : { entryPoints: [`relay/${setting('main')}`] }),
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
  const vaults = await mf.getDurableObjectNamespace('VAULTS')
  const vaultObject = (vault: string) =>
    vaults.get(vaults.idFromName(vault)) as unknown as ClockedVault
  return { url, secret, vaultObject, close: () => mf.dispose() }
}

// The suite enrolls and pairs more often in a minute than the shared limits allow; they are tested below.
relaySuite('a Durable Object (Miniflare)', () => startWorker({ shared: false }))

it('sweeps a vault on its alarm: drops one left empty and unused, keeps one in use', async () => {
  const host = await startWorker({ shared: false, clocked: true })
  const day = 24 * 3600 * 1000
  try {
    const object = host.vaultObject
    const before = Date.now()
    const lost = await createVault(host)
    const alarm = await object(lost.vault).alarmAt()
    expect(alarm).toBeGreaterThanOrEqual(before + ORPHAN_AGE_MS - 1000)
    expect(alarm).toBeLessThanOrEqual(Date.now() + ORPHAN_AGE_MS + 1000)

    const busy = await createVault(host)
    const pushed = await connect(host, busy.vault, busy.first.token)
    pushed.socket.send({ type: 'push', id: 'r', base: 0, kind: 'record', chunks: [4] }, [
      bytes(4, 5),
    ])
    await pushed.socket.expect('pushed')
    pushed.socket.close()
    const shared = await createVault(host)
    await enrolled(host, shared)
    const old = await createVault(host)
    const winner = await createVault(host)
    expect((await retireVault(host, old.vault, winner.vault)).status).toBe(200)

    await object(lost.vault).forgetAlarm()
    const watching = await connect(host, lost.vault, lost.first.token)
    expect(await object(lost.vault).alarmAt()).not.toBeNull()

    await object(lost.vault).advance(91 * day)
    for (const vault of [lost, busy, shared, winner]) await object(vault.vault).runAlarm()
    expect(await object(busy.vault).alarmAt()).toBeNull()
    expect(await object(winner.vault).alarmAt()).toBeNull()
    expect(await object(shared.vault).alarmAt()).toBeGreaterThan(Date.now() + 91 * day)
    expect(await object(lost.vault).alarmAt()).toBeGreaterThan(Date.now() + 91 * day)
    watching.socket.send({ type: 'usage' })
    await watching.socket.expect('usage')

    watching.socket.close()
    // The object may learn of the close after the client does; until then the alarm counts it connected.
    await expect
      .poll(async () => {
        await object(lost.vault).advance(91 * day)
        await object(lost.vault).runAlarm()
        return object(lost.vault).alarmAt()
      })
      .toBeNull()
    const refused = await TestSocket.open(
      socketUrl(host, lost.vault),
      socketProtocols(lost.first.token),
    )
    expect((await refused.expect('error')).message['code']).toBe('E_SYNC_NO_VAULT')
    for (const vault of [busy, shared, winner]) {
      const kept = await connect(host, vault.vault, vault.first.token)
      expect(kept.welcome['type']).toBe('welcome')
      kept.socket.close()
    }
  } finally {
    await host.close()
  }
})

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
