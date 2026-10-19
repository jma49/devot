import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { importReason } from '../../src/renderer/src/importReasons'

const SOURCES = ['src-tauri/src/import.rs', 'src-tauri/src/commands/files.rs', 'src/core/import.ts']

it('every import problem code has a reason in the catalog', () => {
  const codes = new Set(
    SOURCES.flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(/"(E_(?:IMPORT|FILE)_[A-Z_]+)"|'(E_IMPORT_[A-Z_]+)'/g),
    ]).map((m) => (m[1] ?? m[2])!),
  )
  // Bug codes keep the generic text; copying attachments is no part of an import.
  for (const generic of [
    'E_IMPORT_FAILED',
    'E_FILE_BODY_INVALID',
    'E_FILE_ID_INVALID',
    'E_FILE_COPIES_TOO_MANY',
  ]) {
    codes.delete(generic)
  }
  expect(codes.size).toBeGreaterThan(10)
  expect([...codes].filter((code) => importReason(code) === null)).toEqual([])
})
