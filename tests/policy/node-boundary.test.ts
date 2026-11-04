import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

// The core runs in the UI worker and on iOS, and the UI in a webview: neither has Node's modules,
// whether imported as `node:fs` or as plain `fs`.

type Restriction = { paths?: { name: string }[]; patterns?: { group: string[] }[] }
type Override = { files: string[]; rules: Record<string, [string, Restriction]> }
const lint = JSON.parse(readFileSync('.oxlintrc.json', 'utf8')) as { overrides: Override[] }
const nodeModules = builtinModules.filter(
  (name) => !name.startsWith('_') && !name.startsWith('node:'),
)

it.each(['src/core/**', 'src/renderer/**'])('lint refuses every Node module in %s', (files) => {
  const override = lint.overrides.find((o) => o.files.includes(files))
  const [level, restriction] = override?.rules['no-restricted-imports'] ?? []
  expect(level).toBe('error')
  expect(restriction?.patterns?.flatMap((p) => p.group)).toContain('node:*')
  const named = new Set(restriction?.paths?.map((p) => p.name))
  expect(nodeModules.filter((name) => !named.has(name))).toEqual([])
})

it('the core and the UI load no module through require()', () => {
  const files = listFiles('.', 'src/core', 'src/renderer').filter((f) => /\.(ts|tsx)$/.test(f))
  const offenders = files.filter((file) => /\brequire\(/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})
