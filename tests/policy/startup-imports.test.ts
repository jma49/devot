import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { runtimeModuleSpecifiers } from '../support/ts-imports'

const CORE_INDEX = /^(?:\.\.\/)+core(?:\/index(?:\.ts)?)?$/

// The core index re-exports import, export and HTML conversion (parse5, yaml, remark): a value
// import of it from the window puts them in the startup bundle. The worker may use it.
export function hasCoreIndexValueImport(source: string): boolean {
  return runtimeModuleSpecifiers(source).some((spec) => CORE_INDEX.test(spec))
}

it('the window imports only types from the core index', () => {
  const offenders = listFiles('.', 'src/renderer/src')
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => !file.endsWith('core.worker.ts'))
    .filter((file) => hasCoreIndexValueImport(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('flags side-effect, named, multiline, namespace and re-exported values from the core index', () => {
  expect(hasCoreIndexValueImport("import type { NoteRecord } from '../../core'")).toBe(false)
  expect(hasCoreIndexValueImport("import { type NoteRecord } from '../../core'")).toBe(false)
  expect(hasCoreIndexValueImport("export type { NoteRecord } from '../../core'")).toBe(false)
  expect(hasCoreIndexValueImport("import '../../core'")).toBe(true)
  expect(hasCoreIndexValueImport("import '../../core/index'")).toBe(true)
  expect(hasCoreIndexValueImport("import { errorCode } from '../../core'")).toBe(true)
  expect(
    hasCoreIndexValueImport("import {\n  type NoteRecord,\n  errorCode,\n} from '../../core'"),
  ).toBe(true)
  expect(hasCoreIndexValueImport("import * as core from '../../core'")).toBe(true)
  expect(hasCoreIndexValueImport("export { errorCode } from '../../core'")).toBe(true)
  expect(hasCoreIndexValueImport("export * from '../../core'")).toBe(true)
})
