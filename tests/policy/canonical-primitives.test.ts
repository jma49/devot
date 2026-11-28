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

const BASE64_ALLOWED = new Set([
  'src/core/base64.ts',
  // Relay wire format stays zero-import so Node's native type-stripping runs it directly.
  'src/core/sync/protocol.ts',
  // Mermaid stores ASCII JSON coordinates in `data-points`, not binary bytes.
  'src/renderer/src/preview/mermaid-theme.ts',
])

it('encodes and decodes binary base64 in src/ and clipper/ only through src/core/base64.ts', () => {
  const offenders = nonTestSources('src', 'clipper')
    .filter((file) => !BASE64_ALLOWED.has(file))
    .filter((file) => /\b(?:atob|btoa)\s*\(/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('never spreads unbounded byte arrays into String.fromCharCode', () => {
  const offenders = nonTestSources('src', 'clipper').filter((file) =>
    /btoa\s*\(\s*String\.fromCharCode\s*\(\s*\.\.\./.test(readFileSync(file, 'utf8')),
  )
  expect(offenders).toEqual([])
})

it('accesses globalThis.localStorage and sessionStorage only through localStore.ts', () => {
  const offenders = nonTestSources('src/renderer/src')
    .filter((file) => file !== 'src/renderer/src/localStore.ts')
    .filter((file) => /globalThis[^;\n]*(?:local|session)Storage/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('notice components render through the <Notice> primitive in Notices.tsx', () => {
  const offenders = nonTestSources('src/renderer/src')
    .filter((file) => /Notice(s)?\.tsx$/.test(file))
    .filter(
      (file) =>
        file !== 'src/renderer/src/Notices.tsx' && file !== 'src/renderer/src/AuthorshipNotice.tsx',
    )
    .filter((file) => /data-devot-part="notice"/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})
