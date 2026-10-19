import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { PRINT_CSP } from '../../src/core/htmlExport'

// Rust prints every page under its own policy (src-tauri/src/native/macos.rs); the pages the UI makes to print
// must say the same, so the page tells the truth about what printing loads.
it('the UI gives its pages to print the policy Rust prints them under', () => {
  const rust = readFileSync('src-tauri/src/native/macos.rs', 'utf8')
  expect(rust).toContain(`pub const PRINT_POLICY: &str = "${PRINT_CSP}";`)
})
