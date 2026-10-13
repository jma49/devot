import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { TEMPLATES_BOOK_ID } from '../../src/core/books'

// Rust validates every notebook ID it stores or searches by; its test of the
// reserved Templates ID must check the ID the core uses.
it('the Rust test checks the core Templates notebook ID', () => {
  const rust = readFileSync('src-tauri/src/commands/notes.rs', 'utf8')
  expect(rust).toContain(`const TEMPLATES_BOOK_ID: &str = "${TEMPLATES_BOOK_ID}";`)
})
