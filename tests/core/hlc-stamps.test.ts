import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isHlcText } from '../../src/core/hlc'

// Rust's valid_hlc (src-tauri/src/storage/records.rs) reads the same table.
const STAMPS = 'src-tauri/tests/fixtures/hlc-stamps.json'

it('takes the stamps Rust takes, and no others', () => {
  const stamps = JSON.parse(readFileSync(STAMPS, 'utf8')) as { valid: string[]; invalid: string[] }
  expect(stamps.valid.filter((s) => !isHlcText(s))).toEqual([])
  expect(stamps.invalid.filter((s) => isHlcText(s))).toEqual([])
  expect(readFileSync('src-tauri/src/storage/records.rs', 'utf8')).toContain(
    'include_str!("../../tests/fixtures/hlc-stamps.json")',
  )
})
