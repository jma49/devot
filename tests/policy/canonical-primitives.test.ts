import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

const nonTestSources = (...roots: string[]) =>
  listFiles('.', ...roots).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))

it('reads and checks error codes only through src/core/errors.ts', () => {
  const offenders = nonTestSources('src')
    .filter((file) => file !== 'src/core/errors.ts')
    .filter((file) => /\[EWI\]_\[A-Z0-9_\]/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('spells UUID patterns in src/ only in src/core/ids.ts', () => {
  const offenders = nonTestSources('src')
    .filter((file) => file !== 'src/core/ids.ts')
    .filter((file) => /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/i.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('checks plain JSON objects in src/ through src/core/isRecord.ts', () => {
  const offenders = nonTestSources('src')
    .filter((file) => file !== 'src/core/isRecord.ts')
    .filter((file) =>
      /typeof \w+ === ['"]object['"] && \w+ !== null && !Array\.isArray/.test(
        readFileSync(file, 'utf8'),
      ),
    )
  expect(offenders).toEqual([])
})

it('renderer modules never re-export runtime values from core/', () => {
  const offenders = nonTestSources('src/renderer/src').filter((file) =>
    /^export\s+(?!type\b)\{[^}]*\}\s+from\s+'(?:\.\.\/)+core\//m.test(readFileSync(file, 'utf8')),
  )
  expect(offenders).toEqual([])
})
