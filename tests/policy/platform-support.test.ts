import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const json = <T>(path: string) => JSON.parse(read(path)) as T

const minimum = json<{ bundle: { macOS: { minimumSystemVersion: string } } }>(
  'src-tauri/tauri.conf.json',
).bundle.macOS.minimumSystemVersion
const major = minimum.split('.')[0]!

const release = (version: string) => version.split('.').map(Number)
const atMost = (a: string, b: string) => {
  const [x, y] = [release(a), release(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return true
}

it('runs on macOS 15 and later', () => {
  expect(minimum).toBe('15.0')
})

it('says the same macOS and both kinds of Mac wherever it states what Devot needs', () => {
  for (const path of ['README.md', 'docs/architecture.md', 'docs/development.md']) {
    expect({
      path,
      states: read(path).includes(`macOS ${major} or later`),
    }).toEqual({
      path,
      states: true,
    })
  }
  expect(read('README.md')).toContain('Apple Silicon or Intel')
  expect(read('docs/releasing.md')).toContain('Apple Silicon and Intel')
  for (const path of ['README.md', 'docs/releasing.md', 'docs/development.md']) {
    const stale = read(path).match(/Apple Silicon only|macOS 26 or later|_aarch64\.dmg/)?.[0]
    expect({ path, stale }).toEqual({ path, stale: undefined })
  }
})

it('draws only SF Symbols the oldest supported macOS has', () => {
  const { symbols } = json<{ symbols: Record<string, string> }>('design/icons/symbols.json')
  const notebook = json<{
    categories: { icon: string }[]
    symbols: Record<string, unknown>
  }>('design/icons/notebook-symbols.json')
  const drawn = new Set([
    ...Object.entries(symbols)
      .filter(([key]) => !key.startsWith('phone.'))
      .map(([, name]) => name),
    ...Object.keys(notebook.symbols),
    ...notebook.categories.map((category) => category.icon),
  ])
  const { macOS } = json<{ macOS: Record<string, string> }>('design/icons/symbol-availability.json')
  const unlisted = [...drawn].filter((name) => !(name in macOS))
  expect(unlisted).toEqual([])
  const newer = [...drawn].filter((name) => !atMost(macOS[name]!, minimum))
  expect(newer).toEqual([])
  const stale = Object.keys(macOS).filter((name) => !drawn.has(name))
  expect(stale).toEqual([])
})
