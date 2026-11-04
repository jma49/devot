import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// A lazy chunk must never import the worker's entry chunk: WebKit then evaluates the worker
// script a second time, and that copy answers every call with E_CORE_NOT_READY.

const root = join(import.meta.dirname, '../..')

it("no chunk of the core worker imports the worker's entry chunk", async () => {
  const outDir = tempDir('devot-worker-build-')
  await build({
    configFile: join(root, 'vite.config.ts'),
    cacheDir: tempDir('devot-vite-cache-'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true, minify: false },
  })
  const assets = join(outDir, 'assets')
  const files = readdirSync(assets).filter((name) => name.endsWith('.js'))
  const entry = files.find((name) => name.startsWith('core.worker-'))
  expect(entry).toBeDefined()
  // The lazy chunks the worker loads exist, so the check below has something to check.
  const entryCode = readFileSync(join(assets, entry!), 'utf8')
  const lazy = [...entryCode.matchAll(/import\(\s*["'`]\.\/([^"'`]+)["'`]\s*\)/g)].map((m) => m[1])
  expect(lazy.length).toBeGreaterThan(0)
  const importsEntry = new RegExp(
    `(?:from|import)\\s*["'\`]\\./${entry!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`,
  )
  const offenders = files.filter((name) =>
    importsEntry.test(readFileSync(join(assets, name), 'utf8')),
  )
  expect(offenders).toEqual([])
}, 180_000)
