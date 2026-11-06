import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

// Fill with `format` (core `fillPlaceholders`), never `String.replace`: its replacement string reads
// `$$`, `$&`, `$'` and `` $` `` as patterns, which would garble a title holding them.
const PLACEHOLDER_REPLACE = /\.replace(?:All)?\(\s*(['"`])\{/g

it('placeholders are filled with format, not String.replace', () => {
  const offenders = listFiles('.', 'src')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(PLACEHOLDER_REPLACE)].map(
        (m) => `${file}:${text.slice(0, m.index).split('\n').length}`,
      )
    })
  expect(offenders).toEqual([])
})
