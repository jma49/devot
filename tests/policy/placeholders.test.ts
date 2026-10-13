import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// A `{name}` placeholder is filled with `format` (the core's
// `fillPlaceholders`), never with `String.replace`: a replacement string
// reads `$$`, `$&`, `$'` and `` $` `` as patterns, so a title holding them
// would show garbled.
const PLACEHOLDER_REPLACE = /\.replace(?:All)?\(\s*(['"`])\{/g

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

it('placeholders are filled with format, not String.replace', () => {
  const offenders = files('src')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(PLACEHOLDER_REPLACE)].map(
        (m) => `${file}:${text.slice(0, m.index).split('\n').length}`,
      )
    })
  expect(offenders).toEqual([])
})
