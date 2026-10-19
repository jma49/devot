import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  MAX_BODY_BYTES,
  MAX_BODY_VERSION,
  MAX_NOTE_LINKS,
  MAX_TITLE_CHARS,
  MAX_YDOC_BYTES,
} from '../../src/core'

// The app's note_put refuses a note outside these limits, and the core keeps
// notes within them (titles are cut, every storage adapter checks the rest):
// both sides must agree, or a note the core keeps could never be saved.
const NOTES = readFileSync('src-tauri/src/commands/notes.rs', 'utf8')

function rustConst(name: string): number {
  const stated = new RegExp(`const ${name}: (?:usize|i64) = ([^;]+);`).exec(NOTES)?.[1]
  if (!stated) throw new Error(`E_TEST_NO_CONST ${name}`)
  return stated
    .split('*')
    .reduce((product, factor) => product * Number(factor.trim().replaceAll('_', '')), 1)
}

it('uses the limits note_put checks', () => {
  expect(rustConst('MAX_TITLE_CHARS')).toBe(MAX_TITLE_CHARS)
  expect(rustConst('MAX_BODY_BYTES')).toBe(MAX_BODY_BYTES)
  expect(rustConst('MAX_YDOC_BYTES')).toBe(MAX_YDOC_BYTES)
  expect(rustConst('MAX_LINKS')).toBe(MAX_NOTE_LINKS)
  // A body version a write may be based on stays below it, so the version
  // storage moves it on to is still a whole number JavaScript holds exactly.
  expect(rustConst('MAX_BODY_VERSION')).toBe(MAX_BODY_VERSION)
  expect(MAX_BODY_VERSION).toBe(Number.MAX_SAFE_INTEGER)
})
