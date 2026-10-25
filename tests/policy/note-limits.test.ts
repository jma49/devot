import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  MAX_AGENT_WRITE_ROWS,
  MAX_AGENT_WRITES_LISTED,
  MAX_BODY_BYTES,
  MAX_BODY_IDS,
  MAX_BODY_VERSION,
  MAX_NOTE_LINKS,
  MAX_TITLE_CHARS,
  MAX_WRITER_NAME_CHARS,
  MAX_YDOC_BYTES,
} from '../../src/core'

// note_put refuses notes outside these limits and the core keeps notes within them: both sides must
// agree, or a note the core keeps could never be saved.
const NOTES = readFileSync('src-tauri/src/commands/notes.rs', 'utf8')

const AUTHORSHIP = readFileSync('src-tauri/src/commands/authorship.rs', 'utf8')

function rustConst(name: string, source = NOTES): number {
  const stated = new RegExp(`const ${name}: (?:usize|i64|u32) = ([^;]+);`).exec(source)?.[1]
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

it('batches body reads within what notes_bodies takes', () => {
  expect(rustConst('MAX_BODY_IDS')).toBe(MAX_BODY_IDS)
})

it('derives the agent_writes rows within what note_put and agent_writes_list take', () => {
  expect(rustConst('MAX_AGENT_WRITE_ROWS', AUTHORSHIP)).toBe(MAX_AGENT_WRITE_ROWS)
  expect(rustConst('MAX_WRITER_NAME_CHARS', AUTHORSHIP)).toBe(MAX_WRITER_NAME_CHARS)
  expect(rustConst('MAX_AGENT_WRITES_LISTED', AUTHORSHIP)).toBe(MAX_AGENT_WRITES_LISTED)
})
