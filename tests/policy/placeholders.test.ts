import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Fill with `format` (core `fillPlaceholders`), never `String.replace`: its replacement string reads
// `$$`, `$&`, `$'` and `` $` `` as patterns, which would garble a title holding them.
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
