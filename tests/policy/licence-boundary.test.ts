import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

// The licence Worker (licence/) deploys on its own: the app never imports it, and it imports
// nothing but its own modules, so the bundle is what docs/licensing.md describes.

const specifiers = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1] ?? '',
  )
const code = (...paths: string[]) =>
  listFiles('.', ...paths).filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f))

it('nothing in the app imports the licence Worker', () => {
  const offenders = code('src').filter((file) =>
    specifiers(file).some((s) => /(^|\/)licence\/src\//.test(s)),
  )
  expect(offenders).toEqual([])
})

it('the Worker imports only its own modules, with explicit .ts imports', () => {
  const files = code('licence/src')
  expect(files.length).toBeGreaterThan(5)
  const offenders = files.flatMap((file) =>
    specifiers(file)
      .filter((s) => !/^\.\/[a-z-]+\.ts$/.test(s))
      .map((s) => `${file}: ${s}`),
  )
  expect(offenders).toEqual([])
})

it('the Worker is under FSL-1.1-MIT', () => {
  expect(JSON.parse(readFileSync('licence/package.json', 'utf8')).license).toBe('FSL-1.1-MIT')
})
