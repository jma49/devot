import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_ENVELOPE_BYTES } from '../../share/src/app'
import { VIEWER_CSP } from '../../share/src/viewer'

// The bundled Worker in workerd through Miniflare, from the same entry and settings as
// share/wrangler.toml, with KV in memory: nothing is deployed.

const wrangler = readFileSync('share/wrangler.toml', 'utf8')
const setting = (key: string) => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(wrangler)?.[1]
const { cases } = JSON.parse(readFileSync('tests/fixtures/share-vectors.json', 'utf8')) as {
  cases: { key: string; envelope: string }[]
}
const envelope = Buffer.from(cases[0]!.envelope, 'base64url')

let mf: Miniflare
let url = ''
let address = 0

/** Each create comes from an address of its own, so the per-address limit is tested on its own. */
const create = (body: Uint8Array = envelope, lifetime = '7', from = `10.0.0.${++address}`) =>
  fetch(`${url}/v1/shares`, {
    method: 'POST',
    headers: { 'Devot-Lifetime': lifetime, 'CF-Connecting-IP': from },
    body: new Blob([Buffer.from(body)]),
  })

const created = async () => {
  const response = await create()
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; token: string; expiresAt: number }
}

const owner = (method: string, id: string, token: string, body: Uint8Array | null = null) =>
  fetch(`${url}/v1/shares/${id}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: body && new Blob([Buffer.from(body)]),
  })

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [`share/${setting('main')}`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    keepNames: true,
    write: false,
    logLevel: 'silent',
  })
  mf = new Miniflare({
    name: setting('name') ?? '',
    modules: true,
    script: bundle.outputFiles[0]?.text ?? '',
    compatibilityDate: setting('compatibility_date') ?? '',
    kvNamespaces: ['SHARES'],
    ratelimits: {
      CREATE_PER_ADDRESS: { namespace_id: '40881', simple: { limit: 5, period: 60 } },
      WRITES_ALL: { namespace_id: '40882', simple: { limit: 1000, period: 60 } },
    },
    host: '127.0.0.1',
    port: 0,
  })
  url = (await mf.ready).toString().replace(/\/$/, '')
})
afterAll(() => mf?.dispose())

it('wrangler.toml binds KV and both rate limits, as the tests run them', () => {
  expect(setting('main')).toBe('src/worker.ts')
  expect(wrangler).toMatch(/\[\[kv_namespaces\]\]\nbinding = "SHARES"\nid = "[0-9a-f]{32}"/)
  expect(wrangler).toMatch(
    /name = "CREATE_PER_ADDRESS"\nnamespace_id = "\d+"\n\n\[ratelimits\.simple\]\nlimit = 5\nperiod = 60/,
  )
  expect(wrangler).toMatch(
    /name = "WRITES_ALL"\nnamespace_id = "\d+"\n\n\[ratelimits\.simple\]\nlimit = 60\nperiod = 60/,
  )
  const relay = readFileSync('relay/wrangler.toml', 'utf8')
  const ids = [...`${wrangler}${relay}`.matchAll(/namespace_id = "(\d+)"/g)].map((m) => m[1])
  expect(new Set(ids).size).toBe(ids.length)
})

it('serves the host the app shares to, on its own custom domain', () => {
  expect(wrangler).toContain('routes = [{ pattern = "share.devot.online", custom_domain = true }]')
})

describe('a share', () => {
  it('is created with an ID, a token and its expiry, and serves the bytes it was given', async () => {
    const before = Date.now()
    const share = await created()
    expect(share.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(share.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000)
    expect(share.expiresAt).toBeLessThan(Date.now() + 7 * 86_400_000 + 1000)
    const read = await fetch(`${url}/v1/shares/${share.id}`)
    expect(read.status).toBe(200)
    expect(read.headers.get('Cache-Control')).toBe('no-store')
    expect(Buffer.from(await read.arrayBuffer())).toEqual(envelope)
  })

  it('keeps only a hash of the token, beside the bytes', async () => {
    const share = await created()
    const kv = await mf.getKVNamespace('SHARES')
    const { metadata } = await kv.getWithMetadata(share.id)
    const hash = (metadata as { token?: string } | null)?.token
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash).not.toBe(share.token)
  })

  it('is replaced only with its token, and keeps its expiry', async () => {
    const share = await created()
    const next = Buffer.from(cases[1]!.envelope, 'base64url')
    expect((await owner('PUT', share.id, 'x'.repeat(43), next)).status).toBe(404)
    expect((await owner('PUT', share.id, share.token, next)).status).toBe(204)
    const read = await fetch(`${url}/v1/shares/${share.id}`)
    expect(Buffer.from(await read.arrayBuffer())).toEqual(next)
    const kv = await mf.getKVNamespace('SHARES')
    const { metadata } = await kv.getWithMetadata(share.id)
    expect((metadata as { expiresAt?: number } | null)?.expiresAt).toBe(share.expiresAt)
  })

  it('is deleted only with its token, and is gone at once', async () => {
    const share = await created()
    expect((await owner('DELETE', share.id, 'y'.repeat(43))).status).toBe(404)
    expect((await fetch(`${url}/v1/shares/${share.id}`)).status).toBe(200)
    expect((await owner('DELETE', share.id, share.token)).status).toBe(204)
    const read = await fetch(`${url}/v1/shares/${share.id}`)
    expect(read.status).toBe(404)
    expect(await read.json()).toEqual({ error: 'E_SHARE_NOT_FOUND' })
    expect((await owner('PUT', share.id, share.token, envelope)).status).toBe(404)
  })

  it('limits updates and deletes only across the Worker, not by address', async () => {
    const share = await created()
    for (let i = 0; i < 8; i++) {
      expect((await owner('PUT', share.id, share.token, envelope)).status).toBe(204)
    }
  })

  it('answers an unknown ID as it answers a wrong token', async () => {
    const share = await created()
    const unknown = await owner('DELETE', 'A'.repeat(22), share.token)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'E_SHARE_NOT_FOUND' })
  })
})

describe('what a create may hold', () => {
  it('takes only the lifetimes the app offers', async () => {
    for (const lifetime of ['0', '2', '31', '365', '', 'seven']) {
      const response = await create(envelope, lifetime)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'E_SHARE_LIFETIME_INVALID' })
    }
    for (const lifetime of ['1', '30']) expect((await create(envelope, lifetime)).status).toBe(201)
  })

  it('refuses bytes that are not an envelope', async () => {
    for (const body of [
      new Uint8Array(),
      new TextEncoder().encode('<html>hello</html>'.repeat(4)),
    ]) {
      const response = await create(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'E_SHARE_BODY_INVALID' })
    }
  })

  it('refuses a page over the size limit', async () => {
    const big = new Uint8Array(MAX_ENVELOPE_BYTES + 1)
    big.set(envelope.subarray(0, 4))
    // Through Miniflare's own dispatch: over a socket the Worker answers before the upload ends and
    // the connection is reset under the client.
    const response = await mf.dispatchFetch(`${url}/v1/shares`, {
      method: 'POST',
      headers: { 'Devot-Lifetime': '7', 'CF-Connecting-IP': '10.8.8.8' },
      body: big,
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'E_SHARE_TOO_LARGE' })
  })

  it('limits creates from one address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await create(envelope, '1', '10.9.9.9')).status)
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201])
    expect(statuses.slice(5)).toEqual([429, 429])
  })
})

describe('the viewer', () => {
  it('serves the same page for any well-formed ID, under its own policy, never indexed', async () => {
    const response = await fetch(`${url}/s/${'B'.repeat(22)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBe(VIEWER_CSP)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    const html = await response.text()
    expect(html).toContain(`data-share="${'B'.repeat(22)}"`)
    expect(html).toContain('src="/assets/viewer.js"')
  })

  it('serves its script and stylesheet with their types', async () => {
    const script = await fetch(`${url}/assets/viewer.js`)
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toContain('async function openEnvelope')
    const style = await fetch(`${url}/assets/viewer.css`)
    expect(style.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(await style.text()).toContain('--color-text-primary')
  })

  it('answers 404 for anything else', async () => {
    expect((await fetch(`${url}/s/short`)).status).toBe(404)
    expect((await fetch(`${url}/v1/shares/../x`)).status).toBe(404)
    expect((await fetch(`${url}/admin`)).status).toBe(404)
  })
})
