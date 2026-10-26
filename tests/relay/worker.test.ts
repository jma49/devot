import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
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

relaySuite('a Durable Object (Miniflare)', async () => {
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
})
