import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

// The relay (relay/) deploys on its own: the app never imports it, and it takes from the app
// only the wire format, which the Node host runs through Node's type stripping.

const PROTOCOL = 'src/core/sync/protocol.ts'
const specifiers = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1] ?? '',
  )
const code = (...paths: string[]) =>
  listFiles('.', ...paths).filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f))

it('nothing in the app imports the relay', () => {
  const offenders = code('src').filter((file) =>
    specifiers(file).some((s) => /(^|\/)relay\//.test(s) && s.startsWith('.')),
  )
  expect(offenders).toEqual([])
})

it('the relay takes from the app only the wire format, with explicit .ts imports', () => {
  const files = code('relay/src')
  expect(files.length).toBeGreaterThan(3)
  const offenders = files.flatMap((file) =>
    specifiers(file)
      .filter((s) => s.startsWith('.'))
      .filter((s) => !s.endsWith('.ts') || (s.includes('/src/') && !s.endsWith(PROTOCOL)))
      .map((s) => `${file}: ${s}`),
  )
  expect(offenders).toEqual([])
})

it('the wire format imports nothing, so it runs on every host as it is', () => {
  expect(specifiers(PROTOCOL)).toEqual([])
})
